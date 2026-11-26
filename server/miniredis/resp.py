"""RESP2 encoding and decoding.

Only the subset that clients send (arrays of bulk strings, plus inline
commands typed by hand over telnet/nc) is parsed. Replies use simple strings,
errors, integers, bulk strings and arrays.
"""
from __future__ import annotations

import asyncio

CRLF = b"\r\n"
MAX_MULTIBULK = 1024 * 1024
MAX_INLINE = 64 * 1024


class ProtocolError(Exception):
    """The client sent bytes that are not valid RESP2."""


# --------------------------------------------------------------------------- encoders

def simple(s: str) -> bytes:
    return b"+" + s.encode() + CRLF


def error(msg: str) -> bytes:
    # Errors may not contain newlines.
    return b"-" + msg.replace("\r", " ").replace("\n", " ").encode() + CRLF


def integer(n: int) -> bytes:
    return b":" + str(int(n)).encode() + CRLF


def bulk(b: bytes | None) -> bytes:
    if b is None:
        return b"$-1\r\n"
    return b"$" + str(len(b)).encode() + CRLF + b + CRLF


def array(encoded_items: list[bytes] | None) -> bytes:
    if encoded_items is None:
        return b"*-1\r\n"
    return b"*" + str(len(encoded_items)).encode() + CRLF + b"".join(encoded_items)


def bulk_array(items: list[bytes | None]) -> bytes:
    return array([bulk(i) for i in items])


OK = simple("OK")
PONG = simple("PONG")
NULL = bulk(None)


# --------------------------------------------------------------------------- decoders

def _parse_len(line: bytes, what: str) -> int:
    try:
        return int(line)
    except ValueError:
        raise ProtocolError(f"invalid {what} length") from None


async def read_command(reader: asyncio.StreamReader, max_bulk: int) -> list[bytes] | None:
    """Read one command. Returns None on clean EOF, [] for an empty line."""
    try:
        line = await reader.readuntil(CRLF)
    except asyncio.IncompleteReadError as e:
        if e.partial:
            raise ProtocolError("unexpected end of stream") from None
        return None
    except asyncio.LimitOverrunError:
        raise ProtocolError("too big inline request") from None

    if line[:1] == b"*":
        n = _parse_len(line[1:-2], "multibulk")
        if n <= 0:
            return []
        if n > MAX_MULTIBULK:
            raise ProtocolError("invalid multibulk length")
        args: list[bytes] = []
        for _ in range(n):
            try:
                hdr = await reader.readuntil(CRLF)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                raise ProtocolError("unexpected end of stream") from None
            if hdr[:1] != b"$":
                got = hdr[:1].decode("latin-1")
                raise ProtocolError(f"expected '$', got '{got}'")
            ln = _parse_len(hdr[1:-2], "bulk")
            if ln < 0 or ln > max_bulk:
                raise ProtocolError("invalid bulk length")
            try:
                data = await reader.readexactly(ln + 2)
            except asyncio.IncompleteReadError:
                raise ProtocolError("unexpected end of stream") from None
            if data[-2:] != CRLF:
                raise ProtocolError("bulk string not terminated by CRLF")
            args.append(data[:-2])
        return args

    # Inline command ("PING\r\n" typed in telnet).
    if len(line) > MAX_INLINE:
        raise ProtocolError("too big inline request")
    return line.strip().split()


def encode_bulk_array(items: list[bytes]) -> bytes:
    out = [b"*", str(len(items)).encode(), CRLF]
    for it in items:
        out += [b"$", str(len(it)).encode(), CRLF, it, CRLF]
    return b"".join(out)


def parse_bulk_array(buf: bytes) -> list[bytes]:
    """Strictly parse a buffer that holds exactly one array of bulk strings."""
    try:
        if buf[:1] != b"*":
            raise ProtocolError("expected array")
        end = buf.index(CRLF)
        n = int(buf[1:end])
        pos = end + 2
        items = []
        for _ in range(n):
            if buf[pos:pos + 1] != b"$":
                raise ProtocolError("expected bulk")
            end = buf.index(CRLF, pos)
            ln = int(buf[pos + 1:end])
            start = end + 2
            stop = start + ln
            if ln < 0 or buf[stop:stop + 2] != CRLF:
                raise ProtocolError("bad bulk")
            items.append(buf[start:stop])
            pos = stop + 2
        if pos != len(buf):
            raise ProtocolError("trailing bytes")
        return items
    except (ValueError, IndexError) as e:
        raise ProtocolError(str(e)) from None
