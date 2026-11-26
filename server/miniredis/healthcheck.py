"""Readiness probe: exits 0 only when the server reports status:ready.

Usage: python -m miniredis.healthcheck [host] [port]
"""
import os
import socket
import sys


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("MINIREDIS_PORT", "6380"))
    password = os.environ.get("MINIREDIS_REQUIREPASS")
    try:
        with socket.create_connection((host, port), timeout=2) as s:
            if password:
                pw = password.encode()
                s.sendall(b"*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n" % (len(pw), pw))
                s.recv(256)
            s.sendall(b"*2\r\n$4\r\nINFO\r\n$11\r\npersistence\r\n")
            data = b""
            while b"\r\n\r\n" not in data and len(data) < 65536:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
    except OSError as e:
        print(f"unreachable: {e}")
        return 1
    ok = b"status:ready" in data
    print("ready" if ok else "not ready")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
