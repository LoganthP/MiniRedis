"""Minimal asyncio RESP2 client with a small connection pool and pipelining.

The dashboard API talks to the database through the exact same wire protocol
that redis-cli uses; there is no side channel into the server's memory.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass


class ReplyError(Exception):
    """An error reply (-ERR ...) from the server."""

    @property
    def code(self) -> str:
        return str(self).split(" ", 1)[0]


class Unreachable(Exception):
    """The database could not be reached or closed the connection."""


@dataclass
class _Conn:
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter

    def close(self) -> None:
        try:
            self.writer.close()
        except Exception:
            pass


def encode(args: tuple) -> bytes:
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        b = a if isinstance(a, bytes) else str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(b), b))
    return b"".join(out)


async def read_reply(r: asyncio.StreamReader):
    line = await r.readuntil(b"\r\n")
    t, rest = line[:1], line[1:-2]
    if t == b"+":
        return rest.decode("utf-8", "replace")
    if t == b"-":
        return ReplyError(rest.decode("utf-8", "replace"))
    if t == b":":
        return int(rest)
    if t == b"$":
        n = int(rest)
        if n < 0:
            return None
        data = await r.readexactly(n + 2)
        return data[:-2]
    if t == b"*":
        n = int(rest)
        if n < 0:
            return None
        return [await read_reply(r) for _ in range(n)]
    raise Unreachable(f"unexpected reply type {t!r}")


class RespClient:
    def __init__(self, host: str, port: int, password: str | None = None,
                 pool_size: int = 8, timeout: float = 5.0, connect_timeout: float = 1.0) -> None:
        self.host, self.port, self.password = host, port, password
        self.timeout = timeout
        # Short connect timeout: when the database container is gone, a
        # connect() to its old address can hang for seconds instead of failing.
        self.connect_timeout = connect_timeout
        self._idle: list[_Conn] = []
        self._sem = asyncio.Semaphore(pool_size)

    async def _connect(self) -> _Conn:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port, limit=1 << 22), self.connect_timeout)
        except (OSError, asyncio.TimeoutError) as e:
            raise Unreachable(f"cannot connect to {self.host}:{self.port}: {e}") from None
        conn = _Conn(reader, writer)
        if self.password:
            writer.write(encode(("AUTH", self.password)))
            await writer.drain()
            reply = await asyncio.wait_for(read_reply(reader), self.timeout)
            if isinstance(reply, ReplyError):
                conn.close()
                raise Unreachable(f"authentication failed: {reply}")
        return conn

    async def pipeline_raw(self, commands: list[tuple], timeout: float | None = None) -> list:
        """Send commands back-to-back on one connection; error replies are
        returned as ReplyError instances instead of raised.

        A pooled connection may point at a server process that has since died
        (crash + restart). If such a reused connection fails before any reply
        arrives, the request never reached a live server, so it is retried
        once on a fresh connection."""
        timeout = timeout or self.timeout
        async with self._sem:
            for attempt in (0, 1):
                reused = bool(self._idle)
                conn = self._idle.pop() if reused else await self._connect()
                replies: list = []
                try:
                    conn.writer.write(b"".join(encode(c) for c in commands))
                    await conn.writer.drain()
                    for _ in commands:
                        replies.append(await asyncio.wait_for(read_reply(conn.reader), timeout))
                except (OSError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError) as e:
                    conn.close()
                    stale = reused and not replies and not isinstance(e, asyncio.TimeoutError)
                    if stale and attempt == 0:
                        self.reset()  # every other pooled connection is stale too
                        continue
                    raise Unreachable(f"connection lost: {e.__class__.__name__}") from None
                except BaseException:
                    conn.close()
                    raise
                self._idle.append(conn)
                return replies
        raise Unreachable("unreachable")  # pragma: no cover

    async def call_raw(self, *args):
        return (await self.pipeline_raw([args]))[0]

    async def call(self, *args):
        reply = await self.call_raw(*args)
        if isinstance(reply, ReplyError):
            raise reply
        return reply

    async def send_and_forget(self, *args) -> None:
        """Send a command on a fresh connection without waiting (DEBUG CRASH)."""
        conn = await self._connect()
        try:
            conn.writer.write(encode(args))
            await conn.writer.drain()
            try:
                await asyncio.wait_for(conn.reader.read(1), 1.0)
            except (asyncio.TimeoutError, OSError):
                pass
        finally:
            conn.close()

    def reset(self) -> None:
        for c in self._idle:
            c.close()
        self._idle.clear()
