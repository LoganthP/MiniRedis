"""Stateless signed session tokens for the dashboard's write actions."""
from __future__ import annotations

import base64
import hashlib
import hmac
import time

from fastapi import Header, HTTPException, Request


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def issue_token(secret: str, hours: int) -> tuple[str, int]:
    exp = int(time.time()) + hours * 3600
    payload = f"admin.{exp}"
    token = base64.urlsafe_b64encode(f"{payload}.{_sign(secret, payload)}".encode()).decode()
    return token, exp


def verify_token(secret: str, token: str) -> bool:
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        who, exp, sig = raw.split(".")
    except Exception:
        return False
    payload = f"{who}.{exp}"
    if not hmac.compare_digest(sig, _sign(secret, payload)):
        return False
    return exp.isdigit() and int(exp) > time.time()


def check_password(expected: str, given: str) -> bool:
    return hmac.compare_digest(expected.encode(), given.encode())


def is_authenticated(request: Request, authorization: str | None) -> bool:
    settings = request.app.state.settings
    if not settings.auth_required:
        return True
    if not authorization or not authorization.lower().startswith("bearer "):
        return False
    return verify_token(settings.session_secret, authorization[7:].strip())


def require_auth(request: Request, authorization: str | None = Header(default=None)) -> None:
    if not is_authenticated(request, authorization):
        raise HTTPException(status_code=401, detail="Sign in to make changes.")


def can_read(request: Request, authorization: str | None) -> bool:
    settings = request.app.state.settings
    return settings.public_reads or is_authenticated(request, authorization)


def require_read(request: Request, authorization: str | None = Header(default=None)) -> None:
    if not can_read(request, authorization):
        raise HTTPException(status_code=401, detail="Sign in to view data on this instance.")
