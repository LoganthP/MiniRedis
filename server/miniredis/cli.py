"""A tiny redis-cli replacement for containers that do not ship redis-cli.

    python -m miniredis.cli [-H host] [-p port] [-a password] COMMAND [args...]
"""
import argparse
import os
import socket
import sys


def _read(f):
    line = f.readline()
    t, rest = line[:1], line[1:-2].decode("utf-8", "replace")
    if t == b"+":
        return rest
    if t == b"-":
        return f"(error) {rest}"
    if t == b":":
        return f"(integer) {rest}"
    if t == b"$":
        n = int(rest)
        return "(nil)" if n < 0 else f.read(n + 2)[:-2].decode("utf-8", "replace")
    if t == b"*":
        n = int(rest)
        if n <= 0:
            return "(empty array)"
        return "\n".join(f"{i + 1}) {_read(f)}" for i in range(n))
    return line.decode("utf-8", "replace")


def main() -> int:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("-H", "--host", default="127.0.0.1")
    ap.add_argument("-p", "--port", type=int, default=int(os.environ.get("MINIREDIS_PORT", "6380")))
    ap.add_argument("-a", "--password", default=os.environ.get("MINIREDIS_REQUIREPASS"))
    ap.add_argument("command", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    if not a.command:
        print(__doc__)
        return 2

    def enc(args):
        out = b"*%d\r\n" % len(args)
        for x in args:
            b = x.encode()
            out += b"$%d\r\n%s\r\n" % (len(b), b)
        return out

    with socket.create_connection((a.host, a.port), timeout=120) as s:
        f = s.makefile("rb")
        if a.password:
            s.sendall(enc(["AUTH", a.password]))
            _read(f)
        s.sendall(enc(a.command))
        out = _read(f)
    print(out)
    return 1 if out.startswith("(error)") else 0


if __name__ == "__main__":
    sys.exit(main())
