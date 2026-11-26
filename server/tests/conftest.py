import os
import signal
import socket
import subprocess
import sys
import time

import pytest

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SERVER_DIR)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RespError(Exception):
    pass


class Conn:
    """Tiny blocking RESP2 client used by the tests."""

    def __init__(self, port: int, timeout: float = 5) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.f = self.sock.makefile("rb")

    def send(self, *args) -> None:
        parts = [b"*%d\r\n" % len(args)]
        for a in args:
            b = a if isinstance(a, bytes) else str(a).encode()
            parts.append(b"$%d\r\n%s\r\n" % (len(b), b))
        self.sock.sendall(b"".join(parts))

    def read(self):
        line = self.f.readline()
        if not line:
            raise ConnectionError("closed")
        t, rest = line[:1], line[1:-2]
        if t == b"+":
            return rest.decode()
        if t == b"-":
            raise RespError(rest.decode())
        if t == b":":
            return int(rest)
        if t == b"$":
            n = int(rest)
            if n < 0:
                return None
            data = self.f.read(n + 2)
            return data[:-2]
        if t == b"*":
            n = int(rest)
            return None if n < 0 else [self.read() for _ in range(n)]
        raise ValueError(f"bad reply {line!r}")

    def __call__(self, *args):
        self.send(*args)
        return self.read()

    def try_(self, *args):
        try:
            return self(*args)
        except RespError as e:
            return e

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class ServerProc:
    def __init__(self, data_dir: str, *extra: str, env: dict | None = None) -> None:
        self.dir = data_dir
        self.extra = list(extra)
        self.env = env
        self.port = free_port()
        self.proc: subprocess.Popen | None = None

    def start(self, wait_ready: bool = True) -> "ServerProc":
        cmd = [sys.executable, "-m", "miniredis", "--port", str(self.port), "--dir", self.dir,
               "--enable-debug-command", "--log-level", "WARNING", *self.extra]
        env = {**os.environ, **(self.env or {})}
        self.proc = subprocess.Popen(cmd, cwd=SERVER_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                c = Conn(self.port)
                info = c("INFO", "persistence").decode()
                c.close()
                if not wait_ready or "status:ready" in info or "status:degraded" in info:
                    return self
            except (OSError, ConnectionError):
                pass
            except RespError as e:
                if str(e).startswith("NOAUTH"):
                    time.sleep(0.3)
                    return self
            if self.proc.poll() is not None:
                raise RuntimeError("server exited: " + self.proc.stdout.read().decode())
            time.sleep(0.05)
        raise TimeoutError("server did not become ready")

    def conn(self) -> Conn:
        return Conn(self.port)

    def info(self) -> dict:
        c = self.conn()
        raw = c("INFO").decode()
        c.close()
        out = {}
        for line in raw.splitlines():
            if ":" in line and not line.startswith("#"):
                k, v = line.split(":", 1)
                out[k] = v
        return out

    def kill9(self) -> None:
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(5)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


@pytest.fixture
def server(tmp_path):
    s = ServerProc(str(tmp_path / "data")).start()
    yield s
    s.stop()


@pytest.fixture
def make_server(tmp_path):
    started: list[ServerProc] = []

    def make(*extra: str, data_dir: str | None = None, env: dict | None = None) -> ServerProc:
        s = ServerProc(data_dir or str(tmp_path / "data"), *extra, env=env)
        started.append(s)
        return s

    yield make
    for s in started:
        s.stop()
