import os
import socket
import subprocess
import sys
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "api"))

from app.main import create_app  # noqa: E402
from app.settings import Settings  # noqa: E402

SERVER_DIR = os.path.join(ROOT, "server")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DB:
    def __init__(self, data_dir):
        self.dir, self.port, self.proc = data_dir, free_port(), None

    def start(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "miniredis", "--port", str(self.port), "--dir", self.dir,
             "--enable-debug-command", "--log-level", "WARNING"], cwd=SERVER_DIR)
        for _ in range(200):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=1) as s:
                    s.sendall(b"PING\r\n")
                    if s.recv(16).startswith(b"+PONG"):
                        return self
            except OSError:
                time.sleep(0.05)
        raise TimeoutError

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(10)


@pytest.fixture
def dbproc(tmp_path):
    d = DB(str(tmp_path / "data")).start()
    yield d
    d.stop()


def make_client(port, password="pw", public_reads=True):
    s = Settings()
    s.db_port, s.db_host, s.dashboard_password = port, "127.0.0.1", password
    s.public_reads = public_reads
    s.reports_dir = tempfile.mkdtemp()
    return TestClient(create_app(s))


def login(c):
    r = c.post("/api/login", json={"password": "pw"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_health_and_overview(dbproc):
    with make_client(dbproc.port) as c:
        assert c.get("/api/health").json()["db"] == {"reachable": True, "status": "ready"}
        ov = c.get("/api/overview").json()
        assert ov["reachable"] and ov["status"] == "ready"
        assert ov["recovery"]["ok"] is True
        assert ov["persistence"]["appendfsync"] == "always"


def test_writes_require_login(dbproc):
    with make_client(dbproc.port) as c:
        assert c.get("/api/session").json() == {"auth_required": True, "authenticated": False, "can_read": True,
                                               "public_reads": True, "crash_demo_enabled": True,
                                               "demo_workload_enabled": True}
        assert c.put("/api/key", json={"key": "a", "value": "1"}).status_code == 401
        assert c.post("/api/login", json={"password": "wrong"}).status_code == 401
        h = login(c)
        assert c.get("/api/session", headers=h).json()["authenticated"] is True
        assert c.put("/api/key", json={"key": "a", "value": "1"}, headers=h).status_code == 200
        assert c.put("/api/key", json={"key": "a", "value": "1"},
                     headers={"Authorization": "Bearer forged"}).status_code == 401


def test_key_lifecycle(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        r = c.put("/api/key", json={"key": "user:1", "value": "Asha", "ttl_seconds": 120}, headers=h).json()
        assert r["command"] == ["SET", "user:1", "Asha", "EX", "120"]
        assert 119_000 <= r["key"]["ttl_ms"] <= 120_000
        assert r["key"]["expire_at_ms"] > time.time() * 1000
        d = c.get("/api/key", params={"key": "user:1"}).json()
        assert d["value"] == "Asha" and d["size"] == 4
        r = c.put("/api/key", json={"key": "user:1", "value": "Asha R", "keep_ttl": True}, headers=h).json()
        assert r["key"]["ttl_ms"] is not None
        r = c.post("/api/key/expire", json={"key": "user:1", "ttl_seconds": None}, headers=h).json()
        assert r["command"] == ["PERSIST", "user:1"] and r["key"]["ttl_ms"] is None
        assert c.put("/api/key", json={"key": "user:1", "value": "x", "only_if_new": True},
                     headers=h).status_code == 409
        assert c.delete("/api/key", params={"key": "user:1"}, headers=h).json()["deleted"] == 1
        assert c.get("/api/key", params={"key": "user:1"}).status_code == 404
        assert c.post("/api/key/expire", json={"key": "user:1", "ttl_seconds": 5}, headers=h).status_code == 404


def test_key_listing_pages(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        first = c.post("/api/sample-data", headers=h).json()
        assert (first["loaded"], first["added"], first["reset"], first["unchanged"]) == (16, 16, 0, 0)
        for i in range(30):
            c.put("/api/key", json={"key": f"item:{i:02d}", "value": "v" * i}, headers=h)
        page1 = c.get("/api/keys", params={"match": "item:*", "count": 20}).json()
        assert len(page1["keys"]) == 20 and page1["next_cursor"] == 20 and page1["total"] == 46
        page2 = c.get("/api/keys", params={"match": "item:*", "count": 20, "cursor": 20}).json()
        assert len(page2["keys"]) == 10 and page2["next_cursor"] == 0
        sess = c.get("/api/keys", params={"match": "demo:session:*"}).json()["keys"]
        assert all(k["ttl_ms"] for k in sess)
        assert page1["keys"][3]["preview"] == "vvv"


def test_command_console(dbproc):
    with make_client(dbproc.port) as c:
        r = c.post("/api/command", json={"command": "PING"}).json()
        assert r["reply"] == {"type": "status", "value": "PONG"}
        assert c.post("/api/command", json={"command": 'SET "a b" "hello world"'}).status_code == 401
        h = login(c)
        assert c.post("/api/command", json={"command": 'SET "a b" "hello world"'}, headers=h).json()["reply"]["value"] == "OK"
        r = c.post("/api/command", json={"command": 'GET "a b"'}).json()
        assert r["reply"] == {"type": "bulk", "value": "hello world", "binary": False}
        r = c.post("/api/command", json={"command": "SCAN 0"}).json()
        assert r["reply"]["type"] == "array"
        r = c.post("/api/command", json={"command": "GET"}).json()
        assert r["reply"]["type"] == "error"
        assert c.post("/api/command", json={"command": "SHUTDOWN"}, headers=h).status_code == 403
        assert c.post("/api/command", json={"command": 'GET "unterminated'}).status_code == 400


def test_offline_database_is_reported(tmp_path):
    with make_client(free_port()) as c:
        ov = c.get("/api/overview").json()
        assert ov == {**ov, "reachable": False, "status": "offline"}
        r = c.get("/api/keys")
        assert r.status_code == 503 and r.json()["code"] == "OFFLINE"


def test_crash_demo_and_recovery(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        c.put("/api/key", json={"key": "persistent", "value": "survives"}, headers=h)
        c.put("/api/key", json={"key": "expiring", "value": "ticks", "ttl_seconds": 300}, headers=h)
        deadline = c.get("/api/key", params={"key": "expiring"}).json()["expire_at_ms"]
        assert c.post("/api/demo/crash", headers=h).json()["ok"]
        dbproc.proc.wait(5)
        assert dbproc.proc.returncode == 1
        assert c.get("/api/overview").json()["reachable"] is False
        dbproc.start()
        ov = c.get("/api/overview").json()
        assert ov["status"] == "ready" and ov["recovery"]["replayed_ops"] == 2
        assert c.get("/api/key", params={"key": "persistent"}).json()["value"] == "survives"
        assert c.get("/api/key", params={"key": "expiring"}).json()["expire_at_ms"] == deadline
        hist = c.get("/api/recovery/history").json()["history"]
        assert len(hist) == 2


def test_auth_disabled_mode(dbproc):
    with make_client(dbproc.port, password="") as c:
        assert c.get("/api/session").json()["auth_required"] is False
        assert c.put("/api/key", json={"key": "open", "value": "1"}).status_code == 200


def test_aof_tail_and_wire(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        r = c.post("/api/command", json={"command": "SET k v"}, headers=h).json()
        assert r["wire"] == "*3\\r\\n$3\\r\\nSET\\r\\n$1\\r\\nk\\r\\n$1\\r\\nv\\r\\n"
        recs = c.get("/api/aof/tail", params={"count": 5}).json()["records"]
        assert recs[-1]["op"] == "SET" and recs[-1]["args"] == ["k", "v"] and len(recs[-1]["crc32"]) == 8
        assert c.get("/api/overview").json()["instance"]["port"] == dbproc.port


def test_private_reads_require_sign_in(dbproc):
    with make_client(dbproc.port, public_reads=False) as c:
        s = c.get("/api/session").json()
        assert s["can_read"] is False and s["public_reads"] is False
        for method, url, kw in [("get", "/api/keys", {}), ("get", "/api/key", {"params": {"key": "a"}}),
                                ("get", "/api/aof/tail", {}), ("post", "/api/command", {"json": {"command": "PING"}})]:
            assert getattr(c, method)(url, **kw).status_code == 401, url
        # status stays public; recorded key data is redacted
        h = login(c)
        c.put("/api/key", json={"key": "secret:1", "value": "hunter2"}, headers=h)
        dbproc.proc.kill(); dbproc.proc.wait(); dbproc.start()
        ov = c.get("/api/overview").json()
        assert ov["status"] == "ready" and ov["recovery"]["replay_tail"] == [] and ov["recovery"]["redacted"]
        ov2 = c.get("/api/overview", headers=h).json()
        assert ov2["recovery"]["replay_tail"][-1]["args"][0] == "secret:1"
        assert c.get("/api/keys", headers=h).status_code == 200


def test_sample_data_is_idempotent_and_leaves_other_keys(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        c.put("/api/key", json={"key": "mine", "value": "keep"}, headers=h)
        c.post("/api/sample-data", headers=h)
        c.put("/api/key", json={"key": "demo:greeting", "value": "edited"}, headers=h)
        c.delete("/api/key", params={"key": "demo:feature:beta-search"}, headers=h)
        r = c.post("/api/sample-data", headers=h).json()
        assert (r["added"], r["reset"], r["unchanged"]) == (1, 1, 14)
        assert c.get("/api/key", params={"key": "mine"}).json()["value"] == "keep"
        assert c.get("/api/overview").json()["keyspace"]["keys"] == 17


def test_overview_exposes_restart_timeline(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        before = c.get("/api/overview").json()["server"]["run_id"]
        sent = c.post("/api/demo/crash", headers=h).json()["sent_at_ms"]
        dbproc.proc.wait(5)
        dbproc.start()
        ov = c.get("/api/overview").json()
        srv = ov["server"]
        assert srv["run_id"] != before
        tol = 20  # process start time comes from /proc with 10 ms resolution
        assert sent - tol <= srv["process_started_ms"] <= srv["listening_ms"] + tol
        assert srv["listening_ms"] <= srv["ready_ms"] <= ov["observed_ms"]


def test_wait_ready_long_poll(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        run_id = c.get("/api/overview").json()["server"]["run_id"]
        c.post("/api/demo/crash", headers=h)
        dbproc.proc.wait(5)
        import threading
        errors = []

        def restart():
            time.sleep(0.3)
            try:
                dbproc.start()
            except Exception as e:  # pragma: no cover
                errors.append(repr(e))

        t = threading.Thread(target=restart)
        t.start()
        r = c.get("/api/wait-ready", params={"previous_run_id": run_id, "timeout": 10}, headers=h).json()
        t.join()
        assert not errors, errors
        assert r["ready"] and r["run_id"] != run_id
        assert r["phases"][0]["phase"] == "offline" and r["attempts"] > 3
        srv = c.get("/api/overview").json()["server"]
        assert 0 <= r["observed_ms"] - srv["ready_ms"] < 200  # first successful command right after ready
        assert c.get("/api/wait-ready", params={"previous_run_id": "x"}).status_code == 401


def test_instance_cli_prefix(dbproc):
    with make_client(dbproc.port) as c:
        inst = c.get("/api/overview").json()["instance"]
        assert inst["cli_prefix"] == f"redis-cli -p {dbproc.port}" and inst["internal"] is False


def test_crash_under_concurrent_writes_and_slow_recovery(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        run_id = c.get("/api/overview").json()["server"]["run_id"]
        r = c.post("/api/demo/crash", json={"concurrent_writers": 6, "slow_recovery_ms": 800, "load_lead_ms": 500}, headers=h).json()
        assert r["load_id"]
        dbproc.proc.wait(5)
        import threading
        t = threading.Thread(target=dbproc.start)
        t.start()
        w = c.get("/api/wait-ready", params={"previous_run_id": run_id, "timeout": 20}, headers=h).json()
        t.join()
        phases = [p["phase"] for p in w["phases"]]
        assert "recovering" in phases, phases
        v = c.get(f"/api/demo/load/{r['load_id']}", headers=h).json()
        assert v["acked"] > 50 and v["lost"] == 0 and v["recovered"] == v["acked"]
        keys = c.get("/api/keys", params={"match": "lab:load:*"}).json()["keys"]
        assert keys == []  # cleaned up


def test_workload_sees_crash_impact_and_recovers(dbproc, tmp_path):
    s = Settings()
    s.db_port, s.db_host, s.dashboard_password, s.public_reads, s.reports_dir = dbproc.port, "127.0.0.1", "pw", True, str(tmp_path / "r")
    with TestClient(create_app(s)) as c:
        h = login(c)
        assert c.post("/api/workload/start", json={"rps": 80, "duration_s": 60}, headers=h).json()["running"]
        time.sleep(2.5)
        before = c.get("/api/workload").json()
        assert before["last_60s"]["success_rate"] == 1.0 and before["totals"]["hits"] > 0
        run_id = c.get("/api/overview").json()["server"]["run_id"]
        c.post("/api/demo/crash", json={"slow_recovery_ms": 1500}, headers=h)
        dbproc.proc.wait(5)
        import threading
        t = threading.Thread(target=dbproc.start)
        t.start()
        c.get("/api/wait-ready", params={"previous_run_id": run_id, "timeout": 20}, headers=h)
        t.join()
        time.sleep(2.5)
        w = c.get("/api/workload").json()
        kinds = [e["kind"] for e in w["events"]]
        assert "crash" in kinds and "ready" in kinds and "cache_down" in kinds and "cache_up" in kinds, kinds
        assert w["totals"]["fallbacks"] > 0          # product/stock pages served from the backend
        assert w["routes"]["cart"]["errors"] > 0      # carts cannot fall back
        assert w["series"][-1]["errors"] == 0 and w["series"][-1]["fallbacks"] == 0  # recovered
        c.post("/api/workload/stop", headers=h)
        assert c.get("/api/workload").json()["running"] is False
        pts = c.get("/api/metrics/history", params={"minutes": 5}).json()["points"]
        assert any(p["status"] == "offline" or p["status"] == "recovering" for p in pts) or len(pts) >= 2


def test_reports_persist_across_app_restart(dbproc, tmp_path):
    def app():
        s = Settings()
        s.db_port, s.db_host, s.dashboard_password, s.reports_dir = dbproc.port, "127.0.0.1", "pw", str(tmp_path / "r")
        return TestClient(create_app(s))
    with app() as c:
        h = login(c)
        r = c.post("/api/reports", json={"kind": "crash_lab", "report": {"passed": True, "downtime_ms": 88}}, headers=h).json()
        assert r["id"] and c.post("/api/reports", json={"kind": "x", "report": {}}).status_code == 401
    with app() as c:
        h = login(c)
        got = c.get("/api/reports", params={"kind": "crash_lab"}, headers=h).json()["reports"]
        assert got[0]["downtime_ms"] == 88 and c.get(f"/api/reports/{got[0]['id']}", headers=h).json()["passed"] is True
        assert c.get("/api/reports").status_code == 401  # private reads


def test_restore_verifications_listed(dbproc, tmp_path):
    import tarfile
    with make_client(dbproc.port) as c:
        h = login(c)
        c.put("/api/key", json={"key": "a", "value": "1"}, headers=h)
        backup = tmp_path / "b.tar.gz"
        with tarfile.open(backup, "w:gz") as t:
            t.add(dbproc.dir, arcname=".")
        out = subprocess.run([sys.executable, "-m", "miniredis.verify_backup", str(backup), "--compare",
                              f"127.0.0.1:{dbproc.port}", "--record", dbproc.dir, "--name", "b.tar.gz"],
                             cwd=SERVER_DIR, capture_output=True, text=True)
        assert out.returncode == 0, out.stdout + out.stderr
        r = c.get("/api/restores").json()["restores"][0]
        assert r["ok"] and r["backup"] == "b.tar.gz" and r["keys"] == 1 and r["identical"] == 1
