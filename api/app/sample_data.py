"""A clearly labelled sample dataset for demos. Every key starts with "demo:"."""
import json

_users = [
    ("1001", "Asha Rao", "asha@example.com", "admin"),
    ("1002", "Ravi Kumar", "ravi@example.com", "editor"),
    ("1003", "Meera Iyer", "meera@example.com", "viewer"),
    ("1004", "Karthik N", "karthik@example.com", "editor"),
    ("1005", "Divya S", "divya@example.com", "viewer"),
]

SAMPLE_KEYS: list[tuple[str, str, int | None]] = [
    *[(f"demo:user:{uid}", json.dumps({"id": int(uid), "name": n, "email": e, "role": r}), None)
      for uid, n, e, r in _users],
    ("demo:config:app", json.dumps({"theme": "light", "max_upload_mb": 25, "maintenance": False}), None),
    ("demo:feature:new-checkout", "on", None),
    ("demo:feature:beta-search", "off", None),
    ("demo:counter:page-views", "18342", None),
    ("demo:greeting", "Hello from MiniRedis!", None),
    ("demo:session:7f3a9c", json.dumps({"user": 1001, "ip": "10.0.0.12"}), 1800),
    ("demo:session:b81e04", json.dumps({"user": 1002, "ip": "10.0.0.31"}), 900),
    ("demo:cache:weather:mysuru", json.dumps({"temp_c": 24, "sky": "partly cloudy"}), 300),
    ("demo:cache:exchange:usd-inr", "84.12", 120),
    ("demo:ratelimit:10.0.0.7", "17", 60),
    ("demo:otp:+91-98xxxx1234", "482913", 45),
]
