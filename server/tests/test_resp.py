import asyncio

import pytest

from miniredis import resp


def test_encode_and_parse_roundtrip():
    items = [b"SET", b"key", b"binary\r\n\x00value", b""]
    assert resp.parse_bulk_array(resp.encode_bulk_array(items)) == items


@pytest.mark.parametrize("bad", [b"", b"$3\r\nabc\r\n", b"*1\r\n$5\r\nabc\r\n", b"*1\r\n$3\r\nabc\r\nX"])
def test_parse_rejects_malformed(bad):
    with pytest.raises(resp.ProtocolError):
        resp.parse_bulk_array(bad)


def _read(data: bytes):
    async def go():
        r = asyncio.StreamReader()
        r.feed_data(data)
        r.feed_eof()
        return await resp.read_command(r, 1024)
    return asyncio.run(go())


def test_read_command_multibulk_and_inline():
    assert _read(b"*2\r\n$3\r\nGET\r\n$1\r\nk\r\n") == [b"GET", b"k"]
    assert _read(b"PING hello\r\n") == [b"PING", b"hello"]
    assert _read(b"") is None


def test_read_command_errors():
    with pytest.raises(resp.ProtocolError):
        _read(b"*1\r\n:3\r\n")
    with pytest.raises(resp.ProtocolError):
        _read(b"*1\r\n$4096\r\n")  # longer than max_bulk
    with pytest.raises(resp.ProtocolError):
        _read(b"*x\r\n")
