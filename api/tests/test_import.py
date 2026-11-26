import io
import json
import time
import zipfile

from app.synthetic import build
from test_api import dbproc, login, make_client  # noqa: F401  (fixture re-export)


def upload(c, h, name, data):
    r = c.post("/api/import/upload", params={"filename": name}, content=data, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def wait_job(c, h, jid, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/api/import/jobs/{jid}", headers=h).json()
        if j["state"] != "running":
            return j
        time.sleep(0.05)
    raise TimeoutError


def test_zip_inspect_preview_plan_import(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        assert c.post("/api/import/upload", params={"filename": "x.csv"}, content=b"a,b\n1,2\n").status_code == 401
        up = upload(c, h, "shop.zip", build(300, 600))
        files = {f["name"]: f for f in up["files"]}
        assert files["products.csv"]["format"] == "csv"
        assert files["reviews.json"]["format"] == "jsonl"           # .json but line-delimited
        assert files["categories.json"]["format"] == "json_array"
        assert not files["extras/product_photos.xlsx"]["supported"]
        assert "Excel" in files["extras/product_photos.xlsx"]["reason"]

        pv = c.get(f"/api/import/{up['upload_id']}/preview", params={"file": "products.csv"}, headers=h).json()
        assert pv["suggested_id"] == "product_id" and len(pv["records"]) == 8
        assert c.get(f"/api/import/{up['upload_id']}/preview", params={"file": "extras/product_photos.xlsx"}, headers=h).status_code == 400

        c.put("/api/key", json={"key": f"t:prod:{pv['records'][0]['product_id']}", "value": "keep-me"}, headers=h)
        plan = c.post(f"/api/import/{up['upload_id']}/plan", json={"file": "products.csv", "id_column": "product_id", "prefix": "t:prod:"}, headers=h).json()
        assert len(plan["rows"]) == 10 and plan["rows"][0]["exists"] is True and plan["rows"][1]["exists"] is False
        assert plan["existing_under_prefix"] == 1

        job = c.post(f"/api/import/{up['upload_id']}/start", json={"file": "products.csv", "id_column": "product_id", "prefix": "t:prod:"}, headers=h).json()
        j = wait_job(c, h, job["id"])
        assert j["state"] == "done" and j["processed"] == 300 and j["added"] == 299 and j["skipped"] == 1 and j["failed"] == 0
        first = pv["records"][0]["product_id"]
        assert c.get("/api/key", params={"key": f"t:prod:{first}"}).json()["value"] == "keep-me"     # skip existing
        other = json.loads(c.get("/api/key", params={"key": f"t:prod:{pv['records'][1]['product_id']}"}).json()["value"])
        assert other == pv["records"][1] and c.get("/api/key", params={"key": f"t:prod:{pv['records'][1]['product_id']}"}).json()["ttl_ms"] is None

        # overwrite + TTL + record limit -> a separate, expiring group
        job = c.post(f"/api/import/{up['upload_id']}/start", json={"file": "products.csv", "id_column": "product_id", "prefix": "t:hot:",
                                                                 "ttl_seconds": 300, "on_existing": "overwrite", "max_records": 50}, headers=h).json()
        j = wait_job(c, h, job["id"])
        assert j["added"] == 50 and j["processed"] == 50 and "row limit" in (j["note"] or "")
        ttl = c.get("/api/key", params={"key": f"t:hot:{first}"}).json()["ttl_ms"]
        assert 290_000 < ttl <= 300_000

        ds = {d["prefix"]: d for d in c.get("/api/datasets").json()["datasets"]}
        assert ds["t:prod:"]["live_keys"] == 300 and ds["t:hot:"]["live_keys"] == 50 and ds["t:hot:"]["ttl_seconds"] == 300

        ins = c.get("/api/datasets/insights", params={"prefix": "t:prod:"}).json()
        assert ins["category_field"] == "product_category_name" and ins["top_categories"][0]["count"] > 0
        assert ins["numeric_field"] == "price" and "avg" in ins["top_categories"][0]

        fp = c.post("/api/datasets/fingerprint", json={"prefixes": ["t:prod:", "t:hot:"]}, headers=h).json()["fingerprints"]
        assert fp["t:prod:"]["count"] == 300 and fp["t:hot:"]["count"] == 50 and fp["t:hot:"]["with_ttl"] == 50
        fp2 = c.post("/api/datasets/fingerprint", json={"prefixes": ["t:hot:"], "exclude_expiring_within_ms": 400_000}, headers=h).json()["fingerprints"]
        assert fp2["t:hot:"]["count"] == 0 and fp2["t:hot:"]["excluded_expiring_soon"] == 50


def test_orders_jsonl_insights_and_failures(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        lines = [json.dumps({"order_id": f"o{i}", "order_purchase_timestamp": f"2018-0{1 + i % 3}-05 10:00:00", "order_status": "delivered"})
                 for i in range(30)]
        lines.insert(5, "{not json")
        lines.insert(9, json.dumps({"order_status": "missing id"}))
        up = upload(c, h, "orders.json", "\n".join(lines).encode())
        assert up["files"][0]["format"] == "jsonl"
        j = wait_job(c, h, c.post(f"/api/import/{up['upload_id']}/start", json={"file": "orders.json", "id_column": "order_id", "prefix": "t:ord:"}, headers=h).json()["id"])
        assert j["added"] == 30 and j["failed"] == 2 and any("invalid JSON" in f for f in j["failures"]) and any("empty order_id" in f for f in j["failures"])
        ins = c.get("/api/datasets/insights", params={"prefix": "t:ord:"}).json()
        assert ins["date_field"] == "order_purchase_timestamp" and [m["count"] for m in ins["per_month"]] == [10, 10, 10]


def test_upload_limits_and_bad_files(dbproc, monkeypatch):
    from app import importer
    with make_client(dbproc.port) as c:
        h = login(c)
        assert c.post("/api/import/upload", params={"filename": "e.csv"}, content=b"", headers=h).status_code == 400
        monkeypatch.setattr(importer.LIMITS, "max_upload_bytes", 1000)
        r = c.post("/api/import/upload", params={"filename": "big.csv"}, content=b"x" * 5000, headers=h)
        assert r.status_code == 400 and "limit" in r.json()["detail"]
        monkeypatch.setattr(importer.LIMITS, "max_upload_bytes", 10 ** 8)
        monkeypatch.setattr(importer.LIMITS, "max_uncompressed_bytes", 10_000)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("big.csv", "id\n" + "1\n" * 20_000)
        r = c.post("/api/import/upload", params={"filename": "b.zip"}, content=buf.getvalue(), headers=h)
        assert r.status_code == 400 and "expands" in r.json()["detail"]
        up = upload(c, h, "one.json", b'{"a": 1, "b": [1,2]}\n\n')
        assert up["files"][0]["format"] == "jsonl"
        up = upload(c, h, "obj.json", b'{\n "a": 1\n}')
        assert up["files"][0]["supported"] is False


def test_dataset_replay_traffic(dbproc):
    with make_client(dbproc.port) as c:
        h = login(c)
        data = build(200, 300)
        import csv
        pids = {r["product_id"] for r in csv.DictReader(io.TextIOWrapper(zipfile.ZipFile(io.BytesIO(data)).open("products.csv"), "utf-8"))}
        up = upload(c, h, "shop.zip", data)
        start = lambda f, idc, pfx, **kw: wait_job(c, h, c.post(f"/api/import/{up['upload_id']}/start", json={"file": f, "id_column": idc, "prefix": pfx, **kw}, headers=h).json()["id"])
        start("products.csv", "product_id", "t:p:")
        start("orders.jsonl", "order_id", "t:o:")
        assert c.post("/api/workload/start", json={"rps": 50, "duration_s": 30, "dataset_prefix": "t:none:"}, headers=h).status_code == 400
        w = c.post("/api/workload/start", json={"rps": 150, "duration_s": 30, "dataset_prefix": "t:p:"}, headers=h).json()
        assert w["dataset_keys"] == 200 and w["orders_prefix"] == "t:o:" and w["order_keys"] == 300  # orders picked automatically
        assert w["route_sources"] == {"product": "dataset", "order": "dataset", "stock": "dataset_ids", "cart": "dataset_ids"}
        time.sleep(3)
        w = c.get("/api/workload").json()
        for r in ("product", "order", "stock", "cart"):
            assert w["routes"][r]["requests"] > 0, r
        assert w["routes"]["product"]["hits"] > 0 and w["routes"]["product"]["misses"] == 0
        assert w["routes"]["order"]["hits"] > 0
        dl = w["dataset_lookups"]
        assert dl["requests"] == w["routes"]["product"]["requests"] + w["routes"]["order"]["requests"] and dl["hit_rate"] == 1.0
        # stock and cart keys use the imported product ids
        stock = [k["key"] for k in c.get("/api/keys", params={"match": "shop:stock:*", "count": 100}).json()["keys"]]
        assert stock and all(k.split(":", 2)[2] in pids for k in stock)
        cart = c.get("/api/keys", params={"match": "shop:cart:*", "count": 5}).json()["keys"][0]["key"]
        assert all(i in pids for i in json.loads(c.get("/api/key", params={"key": cart}).json()["value"])["items"])
        c.post("/api/workload/stop", headers=h)
        assert c.get("/api/datasets/insights", params={"prefix": "t:p:"}).json()["total_keys"] == 200  # dataset reads never write back
        assert c.get("/api/datasets/insights", params={"prefix": "t:o:"}).json()["total_keys"] == 300

        # a TTL group that expires mid-traffic turns into real misses, served by the backend and never recreated
        start("products.csv", "product_id", "t:gone:", ttl_seconds=2, max_records=50)
        w = c.post("/api/workload/start", json={"rps": 150, "duration_s": 30, "dataset_prefix": "t:gone:", "orders_prefix": ""}, headers=h).json()
        assert w["order_keys"] == 0 and w["route_sources"]["order"] == "off"
        time.sleep(3.5)
        w = c.get("/api/workload").json()
        assert w["routes"]["product"]["hits"] > 0 and w["routes"]["product"]["misses"] > 0
        assert w["routes"]["order"]["requests"] == 0
        assert c.get("/api/datasets/insights", params={"prefix": "t:gone:"}).json()["total_keys"] == 0
        c.post("/api/workload/stop", headers=h)
