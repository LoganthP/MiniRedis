"""TCP front end: accepts connections, parses RESP2, dispatches to the engine."""
from __future__ import annotations

import asyncio
import logging
import signal

from . import resp
from .config import Config
from .db import Client, Database

log = logging.getLogger("miniredis")

_shutdown_request: asyncio.Future | None = None


def request_shutdown(save: bool) -> None:
    if _shutdown_request is not None and not _shutdown_request.done():
        _shutdown_request.set_result(save)


class Server:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.db = Database(cfg)
        self._server: asyncio.base_events.Server | None = None
        self._conns: set[asyncio.Task] = set()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        db = self.db
        peer = writer.get_extra_info("peername")
        addr = f"{peer[0]}:{peer[1]}" if isinstance(peer, tuple) else str(peer)
        if len(db.clients) >= self.cfg.max_clients:
            writer.write(resp.error("ERR max number of clients reached"))
            await writer.drain()
            writer.close()
            return
        client = Client(id=db.next_client_id, addr=addr)
        db.next_client_id += 1
        db.total_connections += 1
        db.clients[client.id] = client
        task = asyncio.current_task()
        self._conns.add(task)
        try:
            pending: list[asyncio.Future] = []  # pipelined writes awaiting fsync, in order

            async def flush_pending() -> None:
                for f in pending:
                    writer.write(await f)
                pending.clear()

            while True:
                try:
                    args = await resp.read_command(reader, self.cfg.max_bulk_bytes)
                except resp.ProtocolError as e:
                    await flush_pending()
                    writer.write(resp.error(f"ERR Protocol error: {e}"))
                    await writer.drain()
                    break
                if args is None:
                    await flush_pending()
                    break
                if not args:
                    continue
                more_buffered = bool(reader._buffer)  # noqa: SLF001
                fut = db.try_submit_write(client, args) if (more_buffered or pending) else None
                if fut is not None:
                    pending.append(fut)
                    if more_buffered and len(pending) < 4096:
                        continue  # keep reading the pipeline; all these writes share one fsync
                    await flush_pending()
                else:
                    # Anything that is not a pipelined write first waits for this
                    # client's earlier writes, so it never observes them before they are durable.
                    await flush_pending()
                    writer.write(await db.execute(client, args))
                if writer.transport.get_write_buffer_size() > 64 * 1024 or not reader._buffer:  # noqa: SLF001
                    await writer.drain()
                if client.close_after_reply:
                    await writer.drain()
                    break
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except asyncio.CancelledError:
            pass
        except Exception:  # never let one client crash the server
            log.exception("unexpected error while serving %s", addr)
            try:
                writer.write(resp.error("ERR internal server error"))
            except Exception:
                pass
        finally:
            db.clients.pop(client.id, None)
            self._conns.discard(task)
            try:
                writer.close()
            except Exception:
                pass

    async def run(self) -> None:
        global _shutdown_request
        loop = asyncio.get_running_loop()
        _shutdown_request = loop.create_future()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, request_shutdown, self.cfg.save_on_shutdown)
            except (NotImplementedError, RuntimeError):  # pragma: no cover - Windows
                pass
        # Listen first so INFO/PING answer while the dataset is still loading.
        self._server = await asyncio.start_server(self._handle, self.cfg.host, self.cfg.port, limit=1 << 20)
        log.info("MiniRedis listening on %s:%d (appendfsync=%s, dir=%s)",
                 self.cfg.host, self.cfg.port, self.cfg.appendfsync, self.cfg.dir)
        from .store import now_ms
        self.db.listening_ms = now_ms()
        await self.db.start()
        save = await _shutdown_request
        log.info("shutting down (save=%s)", save)
        self._server.close()
        await self.db.shutdown(save)
        for t in list(self._conns):
            t.cancel()
        await asyncio.sleep(0)


def main(cfg: Config) -> None:
    import sys
    # Hand the GIL back to the event loop more often while snapshot /
    # fsync threads run (default 5 ms), which trims write-latency tails.
    sys.setswitchinterval(0.001)
    logging.basicConfig(level=cfg.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(Server(cfg).run())
    except KeyboardInterrupt:  # pragma: no cover
        pass
