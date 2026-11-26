"""Harder recovery scenarios: crashes in the middle of a snapshot, and a
SIGKILL while many clients are writing concurrently."""
import json
import os
import threading
import time

import pytest

from conftest import ServerProc


@pytest.mark.parametrize("point", ["snapshot_after_rotate", "snapshot_before_rename", "snapshot_after_rename"])
def test_crash_during_snapshot_loses_nothing(tmp_path, point):
    data = str(tmp_path / "data")
    s = ServerProc(data, env={"MINIREDIS_FAULT": point}).start()
    c = s.conn()
    for i in range(200):
        c("SET", f"k{i}", str(i))
    c("SET", "ttl", "x", "EX", "300")
    deadline = c("PEXPIRETIME", "ttl")
    c.send("SAVE")  # the server dies part-way through the snapshot
    s.proc.wait(10)
    assert s.proc.returncode == 1
    s2 = ServerProc(data).start()
    try:
        c = s2.conn()
        assert c("DBSIZE") == 201
        assert c("GET", "k199") == b"199"
        assert c("PEXPIRETIME", "ttl") == deadline
        assert s2.info()["status"] == "ready"
        if point == "snapshot_before_rename":
            notes = json.loads(c("RECOVERY", "LAST"))["report"]["notes"]
            assert "removed unfinished snapshot temp file" in notes
        # The automatic post-recovery snapshot may be writing a fresh .tmp right
        # now; once no snapshot is in progress, no temp file may remain.
        for _ in range(200):
            if s2.info()["snapshot_in_progress"] == "0":
                break
            time.sleep(0.02)
        assert not os.path.exists(os.path.join(data, "dump.snap.tmp"))
        # and it can snapshot normally afterwards
        assert c("SAVE") == "OK"
    finally:
        s2.stop()


def test_acknowledged_writes_survive_kill_under_concurrent_load(make_server):
    s = make_server().start()
    acked: dict[str, str] = {}
    lock = threading.Lock()
    stop = threading.Event()

    def writer(n: int) -> None:
        c = s.conn()
        i = 0
        while not stop.is_set():
            key, val = f"w{n}:{i}", f"v{i}"
            try:
                ok = c("SET", key, val, *(["EX", "600"] if i % 3 == 0 else []))
            except Exception:
                return  # server died mid-request: this write was never acknowledged
            if ok == "OK":
                with lock:
                    acked[key] = val
            i += 1

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    time.sleep(1.5)
    s.kill9()
    stop.set()
    for t in threads:
        t.join(5)
    assert len(acked) > 500, "load generator produced too few writes to be meaningful"

    s.start()
    c = s.conn()
    missing = [k for k, v in acked.items() if c("GET", k) != v.encode()]
    assert missing == [], f"{len(missing)} acknowledged writes lost, e.g. {missing[:5]}"
    info = s.info()
    assert info["status"] == "ready"


def test_run_id_and_restart_timestamps(make_server):
    s = make_server().start()
    first = s.info()
    s.kill9()
    s.start()
    second = s.info()
    assert first["run_id"] != second["run_id"]
    p0, l0, r0 = int(second["process_started_ms"]), int(second["listening_ms"]), int(second["ready_ms"])
    assert 0 < p0 <= l0 + 20 and l0 <= r0 <= int(second["server_time_ms"])  # /proc start time: 10 ms resolution
    assert r0 - p0 < 10_000


def test_latency_and_queue_metrics(make_server):
    s = make_server().start()
    c = s.conn()
    for i in range(50):
        c("SET", f"m{i}", "x")
        c("GET", f"m{i}")
    info = s.info()
    assert int(info["latency_samples_write"]) >= 50
    assert float(info["write_latency_p95_ms"]) > 0
    assert float(info["log_batch_latency_p50_ms"]) > 0
    assert int(info["write_queue_depth_max"]) >= 1


def test_debug_crash_slow_keeps_server_recovering(make_server):
    from conftest import RespError
    s = make_server().start()
    c = s.conn()
    c("SET", "k", "v")
    c.send("DEBUG", "CRASH", "SLOW", "1500")
    s.proc.wait(5)
    t0 = time.time()
    s.start(wait_ready=False)
    seen_loading = False
    while time.time() - t0 < 10:
        try:
            info = s.info()
        except OSError:
            time.sleep(0.02)
            continue
        if info["status"] == "recovering":
            r = s.conn().try_("GET", "k")
            seen_loading = isinstance(r, RespError) and str(r).startswith("LOADING")
        if info["status"] == "ready":
            break
        time.sleep(0.05)
    assert seen_loading, "expected LOADING replies while recovering"
    assert time.time() - t0 >= 1.4
    assert s.conn()("GET", "k") == b"v"
    assert not os.path.exists(os.path.join(s.dir, ".debug-recovery-delay"))
