import asyncio
import errno
import os
import time

import pytest

from conftest import RespError
from miniredis.config import Config
from miniredis.db import Client, Database
from miniredis.persistence import AppendLog, list_segments


def segments(data_dir):
    return list_segments(os.path.join(data_dir, "aof"))


def test_clean_restart_keeps_data(make_server):
    s = make_server().start()
    c = s.conn()
    c("SET", "a", "1")
    c("SET", "b", "2", "EX", "500")
    s.stop()
    s.start()
    c = s.conn()
    assert c("GET", "a") == b"1"
    assert 498 <= c("TTL", "b") <= 500
    info = s.info()
    assert info["recovery_snapshot_loaded"] == "1"  # shutdown wrote a snapshot


def test_acknowledged_writes_survive_kill9(make_server):
    s = make_server().start()
    c = s.conn()
    for i in range(500):
        assert c("SET", f"k{i}", f"v{i}") == "OK"
    c("DEL", "k0")
    c("SET", "ttl", "x", "EX", "300")
    deadline = c("PEXPIRETIME", "ttl")
    s.kill9()  # no shutdown hook, no snapshot
    s.start()
    c = s.conn()
    assert c("DBSIZE") == 500  # 499 k* keys + ttl
    assert c("GET", "k0") is None
    assert c("GET", "k499") == b"v499"
    assert c("PEXPIRETIME", "ttl") == deadline  # expiry deadline is not reset
    info = s.info()
    assert int(info["recovery_replayed_ops"]) == 502


def test_expiry_continues_during_downtime(make_server):
    s = make_server().start()
    c = s.conn()
    c("SET", "short", "x", "PX", "700")
    c("SET", "long", "x", "EX", "100")
    s.kill9()
    time.sleep(1.0)
    s.start()
    c = s.conn()
    assert c("EXISTS", "short") == 0
    assert c("EXISTS", "long") == 1
    assert int(s.info()["recovery_expired_dropped"]) == 1


def test_snapshot_plus_log_replay(make_server):
    s = make_server().start()
    c = s.conn()
    for i in range(50):
        c("SET", f"a{i}", "x")
    assert c("SAVE") == "OK"
    for i in range(10):
        c("SET", f"b{i}", "y")
    s.kill9()
    s.start()
    info = s.info()
    assert info["recovery_snapshot_keys"] == "50"
    assert info["recovery_replayed_ops"] == "10"
    assert s.conn()("DBSIZE") == 60


def test_auto_snapshot_compacts_log(make_server):
    s = make_server("--snapshot-every-ops", "100").start()
    c = s.conn()
    for i in range(350):
        c("SET", "same", str(i))
    time.sleep(1.5)
    info = s.info()
    assert int(info["snapshots_taken"]) >= 1
    assert int(info["aof_segments"]) == 1
    s.kill9()
    s.start()
    assert s.conn()("GET", "same") == b"349"
    assert int(s.info()["recovery_replayed_ops"]) < 350


def test_incomplete_final_record_is_ignored(make_server):
    s = make_server().start()
    c = s.conn()
    c("SET", "good", "1")
    c("SET", "good2", "2")
    s.kill9()
    _, path = segments(s.dir)[-1]
    with open(path, "ab") as f:
        f.write(b"\x00\x00\x00\x40\x12\x34")  # header of a record that never finished
    s.start()
    c = s.conn()
    assert c("GET", "good2") == b"2"
    info = s.info()
    assert info["status"] == "ready"
    assert info["recovery_truncated_bytes"] == "6"
    assert c("SET", "after", "3") == "OK"  # appends continue on a clean tail
    s.kill9()
    s.start()
    assert s.conn()("GET", "after") == b"3"


def test_torn_final_record_with_bad_checksum_is_ignored(make_server):
    s = make_server().start()
    c = s.conn()
    c("SET", "x", "1")
    c("SET", "y", "2")
    s.kill9()
    _, path = segments(s.dir)[-1]
    with open(path, "r+b") as f:
        f.seek(-2, os.SEEK_END)
        f.write(b"ZZ")  # corrupt the payload of the very last record
    s.start()
    c = s.conn()
    assert c("GET", "x") == b"1"
    assert c("GET", "y") is None
    assert int(s.info()["recovery_truncated_bytes"]) > 0


def test_mid_log_corruption_refuses_to_serve(make_server):
    s = make_server().start()
    c = s.conn()
    for i in range(5):
        c("SET", f"k{i}", "value")
    s.kill9()
    _, path = segments(s.dir)[-1]
    with open(path, "r+b") as f:
        f.seek(8 + 8 + 10)  # inside the first record's payload
        f.write(b"#")
    s.start()
    c = s.conn()
    info = s.info()
    assert info["status"] == "degraded"
    assert "checksum mismatch" in info["degraded_reason"]
    err = c.try_("GET", "k1")
    assert isinstance(err, RespError) and "recovery failed" in str(err)
    assert c("PING") == "PONG"


def test_corrupt_snapshot_refuses_to_serve(make_server):
    s = make_server().start()
    c = s.conn()
    c("SET", "a", "1")
    c("SAVE")
    s.kill9()
    snap = os.path.join(s.dir, "dump.snap")
    with open(snap, "r+b") as f:
        f.seek(20)
        f.write(b"\xff")
    s.start()
    assert s.info()["status"] == "degraded"
    assert isinstance(s.conn().try_("GET", "a"), RespError)


def test_recovery_history_is_recorded(make_server):
    s = make_server().start()
    s.conn()("SET", "a", "1")
    s.kill9()
    s.start()
    import json
    hist = json.loads(s.conn()("RECOVERY", "HISTORY"))
    assert len(hist) == 2
    assert hist[-1]["replayed_ops"] == 1


def test_disk_write_error_rolls_back_and_degrades(tmp_path, monkeypatch):
    async def scenario():
        db = Database(Config(dir=str(tmp_path / "d"), port=0))
        await db.start()
        client = Client(id=1, addr="test")
        assert await db.execute(client, [b"SET", b"k", b"v1"]) == b"+OK\r\n"

        def boom(self, data):
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr(AppendLog, "write_batch", boom)
        # Two concurrent writes in the failing batch, both must be rejected and undone.
        r1, r2 = await asyncio.gather(
            db.execute(client, [b"SET", b"k", b"v2"]),
            db.execute(client, [b"SET", b"new", b"x"]),
        )
        assert r1.startswith(b"-MISCONF") and r2.startswith(b"-MISCONF")
        assert await db.execute(client, [b"GET", b"k"]) == b"$2\r\nv1\r\n"
        assert await db.execute(client, [b"EXISTS", b"new"]) == b":0\r\n"
        assert db.status == "degraded"
        assert (await db.execute(client, [b"DEL", b"k"])).startswith(b"-MISCONF")
        monkeypatch.undo()
        await db.shutdown(save=False)

    asyncio.run(scenario())
    # The failed write never reached disk: a fresh start sees only v1.
    async def check():
        db = Database(Config(dir=str(tmp_path / "d"), port=0))
        await db.start()
        assert await db.execute(Client(id=1, addr="t"), [b"GET", b"k"]) == b"$2\r\nv1\r\n"
        await db.shutdown(save=False)
    asyncio.run(check())


@pytest.mark.parametrize("mode", ["everysec", "no"])
def test_other_fsync_modes_persist_on_clean_shutdown(make_server, mode):
    s = make_server("--appendfsync", mode).start()
    s.conn()("SET", "m", mode)
    s.stop()
    s.start()
    assert s.conn()("GET", "m") == mode.encode()


def test_aof_tail_and_replay_tail(make_server):
    import json
    import zlib
    s = make_server().start()
    c = s.conn()
    c("SET", "a", "1")
    c("SET", "b", "2", "EX", "100")
    c("DEL", "a")
    tail = json.loads(c("AOF", "TAIL", "10"))
    assert [r["op"] for r in tail] == ["SET", "SET", "DEL"]
    assert tail[1]["args"][0] == "b" and tail[1]["args"][2].startswith("PXAT ")
    assert tail[0]["raw"].startswith("*5\\r\\n$1\\r\\n1\\r\\n$1\\r\\nS")
    # the reported checksum matches the bytes on disk
    _, path = segments(s.dir)[-1]
    with open(path, "rb") as f:
        data = f.read()
    r = tail[0]
    payload = data[r["offset"] + 8:r["offset"] + 8 + r["length"]]
    assert f"{zlib.crc32(payload):08x}" == r["crc32"]
    s.kill9()
    s.start()
    last = json.loads(s.conn()("RECOVERY", "LAST"))["report"]
    assert [x["seq"] for x in last["replay_tail"]] == [1, 2, 3]
    hist = json.loads(s.conn()("RECOVERY", "HISTORY"))
    assert hist[-1]["replay_tail"] == []


def test_save_waits_for_running_snapshot(make_server):
    s = make_server("--snapshot-every-ops", "50").start()
    c = s.conn()
    for i in range(60):
        c("SET", f"k{i}", "v")
    assert c("SAVE") == "OK"  # never "already in progress"
    c("SET", "after", "1")
    assert c("SAVE") == "OK"
    s.kill9()
    s.start()
    assert s.info()["recovery_replayed_ops"] == "0"


def test_sigterm_during_post_recovery_snapshot_shuts_down_cleanly(make_server):
    s = make_server("--snapshot-every-ops", "0", "--snapshot-every-seconds", "0").start()
    c = s.conn()
    for i in range(0, 60000, 1000):
        c.sock.sendall(b"".join(b"*3\r\n$3\r\nSET\r\n$7\r\nk%06d\r\n$1\r\nv\r\n" % j for j in range(i, i + 1000)))
        for _ in range(1000):
            c.read()
    s.kill9()
    s.start()           # replays 60k records, then starts a background snapshot
    s.proc.terminate()  # SIGTERM while that snapshot may still be running
    out = s.proc.communicate(timeout=30)[0].decode()
    assert s.proc.returncode == 0
    assert "Traceback" not in out and "RuntimeError" not in out, out
    s.start()
    info = s.info()
    assert info["recovery_snapshot_keys"] == "60000" and info["recovery_replayed_ops"] == "0"
