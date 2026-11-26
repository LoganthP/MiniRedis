import shutil
import socket
import subprocess
import threading
import time

import pytest

from conftest import RespError


def test_ping_echo(server):
    c = server.conn()
    assert c("PING") == "PONG"
    assert c("PING", "hi") == b"hi"
    assert c("ECHO", "x y") == b"x y"


def test_set_get_del_exists(server):
    c = server.conn()
    assert c("SET", "a", "1") == "OK"
    assert c("GET", "a") == b"1"
    assert c("GET", "missing") is None
    assert c("EXISTS", "a", "a", "missing") == 2
    assert c("DEL", "a", "a", "missing") == 1
    assert c("EXISTS", "a") == 0


def test_binary_safe_values(server):
    c = server.conn()
    val = bytes(range(256)) * 4
    c("SET", b"bin\x00key", val)
    assert c("GET", b"bin\x00key") == val
    assert c("STRLEN", b"bin\x00key") == len(val)


def test_set_options(server):
    c = server.conn()
    assert c("SET", "k", "v1", "NX") == "OK"
    assert c("SET", "k", "v2", "NX") is None
    assert c("SET", "k", "v3", "XX", "GET") == b"v1"
    assert c("SET", "nope", "v", "XX") is None
    assert c("SET", "k", "v4", "EX", "100") == "OK"
    assert 99 <= c("TTL", "k") <= 100
    assert c("SET", "k", "v5", "KEEPTTL") == "OK"
    assert 99 <= c("TTL", "k") <= 100
    assert c("SET", "k", "v6") == "OK"
    assert c("TTL", "k") == -1
    for bad in (["EX", "0"], ["EX", "-5"], ["EX", "abc"], ["NX", "XX"], ["EX", "1", "PX", "1"], ["BOGUS"]):
        assert isinstance(c.try_("SET", "k", "v", *bad), RespError)


def test_expire_ttl_persist(server):
    c = server.conn()
    assert c("TTL", "none") == -2
    c("SET", "k", "v")
    assert c("TTL", "k") == -1
    assert c("EXPIRE", "k", "100") == 1
    assert 99 <= c("TTL", "k") <= 100
    assert 99_000 <= c("PTTL", "k") <= 100_000
    assert c("EXPIRE", "k", "50", "GT") == 0
    assert c("EXPIRE", "k", "500", "GT") == 1
    assert c("EXPIRE", "k", "10", "NX") == 0
    assert c("PERSIST", "k") == 1
    assert c("PERSIST", "k") == 0
    assert c("EXPIRE", "missing", "10") == 0
    assert c("EXPIRE", "k", "-1") == 1  # negative TTL deletes, like Redis
    assert c("EXISTS", "k") == 0


def test_errors(server):
    c = server.conn()
    e = c.try_("NOSUCH", "a")
    assert isinstance(e, RespError) and "unknown command" in str(e)
    e = c.try_("GET")
    assert "wrong number of arguments for 'get'" in str(e)
    e = c.try_("EXPIRE", "k", "notanumber")
    assert "not an integer" in str(e)
    assert c("PING") == "PONG"  # connection survives errors


def test_protocol_error_closes_connection(server):
    s = socket.create_connection(("127.0.0.1", server.port))
    s.sendall(b"*1\r\n:oops\r\n")
    data = s.recv(1024)
    assert data.startswith(b"-ERR Protocol error")
    assert s.recv(1024) == b""
    s.close()


def test_inline_and_pipelining(server):
    s = socket.create_connection(("127.0.0.1", server.port))
    s.sendall(b"PING\r\nSET p 1\r\nGET p\r\n")
    buf = b""
    deadline = time.time() + 3
    while buf.count(b"\r\n") < 4 and time.time() < deadline:
        buf += s.recv(1024)
    assert buf == b"+PONG\r\n+OK\r\n$1\r\n1\r\n"
    s.close()


def test_scan_and_keys(server):
    c = server.conn()
    for i in range(25):
        c("SET", f"user:{i:02d}", "x")
    c("SET", "other", "y")
    assert c("DBSIZE") == 26
    seen, cursor = [], b"0"
    while True:
        cursor, keys = c("SCAN", cursor, "MATCH", "user:*", "COUNT", "10")
        seen += keys
        if cursor == b"0":
            break
    assert sorted(seen) == [f"user:{i:02d}".encode() for i in range(25)]
    assert seen == sorted(seen)
    assert c("KEYS", "oth?r") == [b"other"]


def test_lazy_and_active_expiry(server):
    c = server.conn()
    c("SET", "lazy", "v", "PX", "100")
    c("SET", "active", "v", "PX", "100")
    time.sleep(0.25)
    assert c("GET", "lazy") is None
    time.sleep(1.2)  # the active sweep runs once per second
    assert c("DBSIZE") == 0


def test_concurrent_writers(server):
    errors = []

    def worker(n):
        try:
            c = server.conn()
            for i in range(100):
                assert c("SET", f"w{n}:{i}", str(i)) == "OK"
            c.close()
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert server.conn()("DBSIZE") == 2000


def test_concurrent_nx_has_single_winner(server):
    results = []
    barrier = threading.Barrier(16)

    def worker(n):
        c = server.conn()
        barrier.wait()
        results.append(c("SET", "lock", str(n), "NX"))

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("OK") == 1


def test_info_reports_status(server):
    info = server.info()
    assert info["status"] == "ready"
    assert info["appendfsync"] == "always"


def test_requirepass(make_server):
    s = make_server("--requirepass", "s3cret").start()
    c = s.conn()
    assert "NOAUTH" in str(c.try_("GET", "a"))
    assert "WRONGPASS" in str(c.try_("AUTH", "nope"))
    assert c("AUTH", "s3cret") == "OK"
    assert c("SET", "a", "1") == "OK"


@pytest.mark.skipif(shutil.which("redis-cli") is None, reason="redis-cli not installed")
def test_real_redis_cli(server):
    def cli(*args):
        out = subprocess.run(["redis-cli", "-p", str(server.port), *args], capture_output=True, text=True, timeout=10)
        return out.stdout.strip()

    assert cli("PING") == "PONG"
    assert cli("SET", "greeting", "hello world") == "OK"
    assert cli("GET", "greeting") == "hello world"
    assert cli("EXPIRE", "greeting", "120") == "1"
    assert cli("TTL", "greeting") in ("119", "120")
    assert cli("EXISTS", "greeting") == "1"
    assert cli("DEL", "greeting") == "1"
    assert cli("--scan", "--pattern", "*") == ""


def test_pipelined_writes_share_fsync_and_keep_order(server):
    import socket as _s
    s = _s.create_connection(("127.0.0.1", server.port))
    cmds = []
    for i in range(300):
        cmds.append(b"*3\r\n$3\r\nSET\r\n$4\r\npipe\r\n$%d\r\n%d\r\n" % (len(str(i)), i))
    cmds.append(b"*2\r\n$3\r\nGET\r\n$4\r\npipe\r\n")
    cmds.append(b"*3\r\n$3\r\nSET\r\n$1\r\nx\r\n$1\r\n1\r\n")
    cmds.append(b"*2\r\n$3\r\nGET\r\n$1\r\nx\r\n")
    s.sendall(b"".join(cmds))
    expected = b"+OK\r\n" * 300 + b"$3\r\n299\r\n" + b"+OK\r\n" + b"$1\r\n1\r\n"
    buf = b""
    while len(buf) < len(expected):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    assert buf == expected
    s.close()
    info = server.info()
    assert float(info["log_batch_avg_writes"]) > 1.5  # many writes per fsync
