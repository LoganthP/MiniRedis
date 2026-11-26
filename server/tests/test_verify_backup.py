import subprocess
import sys
import tarfile

from conftest import SERVER_DIR


def test_backup_restores_into_fresh_dir_and_matches_live(make_server, tmp_path):
    s = make_server().start()
    c = s.conn()
    for i in range(300):
        c("SET", f"k{i}", f"v{i}", *(["EX", "900"] if i % 4 == 0 else []))
    c("SAVE")
    c("SET", "tail-only", "x")  # lives only in the log, not the snapshot
    backup = tmp_path / "b.tar.gz"
    with tarfile.open(backup, "w:gz") as t:
        t.add(s.dir, arcname=".")
    run = lambda *a: subprocess.run([sys.executable, "-m", "miniredis.verify_backup", str(backup), *a],
                                    cwd=SERVER_DIR, capture_output=True, text=True)
    out = run("--compare", f"127.0.0.1:{s.port}", "--strict")
    assert out.returncode == 0, out.stdout + out.stderr
    assert "recovered 301 keys (75 with TTL)" in out.stdout
    assert "301 identical" not in out.stdout  # sample is 200 by default
    assert "200 identical" in out.stdout
    # the live server diverges -> reported, and --strict fails
    for i in range(300):
        c("SET", f"k{i}", "changed")
    out = run("--compare", f"127.0.0.1:{s.port}", "--strict")
    assert out.returncode == 1 and "value differs" in out.stdout


def test_corrupt_backup_fails(tmp_path):
    d = tmp_path / "d"
    (d / "aof").mkdir(parents=True)
    (d / "dump.snap").write_bytes(b"MRSNAP01" + b"\0" * 40)
    backup = tmp_path / "bad.tar.gz"
    with tarfile.open(backup, "w:gz") as t:
        t.add(d, arcname=".")
    out = subprocess.run([sys.executable, "-m", "miniredis.verify_backup", str(backup)], cwd=SERVER_DIR,
                         capture_output=True, text=True)
    assert out.returncode == 1 and "does not recover" in out.stdout
