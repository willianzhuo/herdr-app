#!/usr/bin/python3
"""Transparent paced SSH transport for input-burst compatibility.

Usage: ssh-paced.py SSH_TARGET REMOTE_COMMAND. Herdr appends the command. Forward every byte unchanged; pace only
stdin in 256-byte pieces at 20 ms intervals. Remote output is not throttled.
The existing herdr-core supervisor remains responsible for reconnection.
"""
import os
import signal
import subprocess
import sys
import threading
import time

if len(sys.argv) != 3:
    raise SystemExit("usage: ssh-paced.py SSH_TARGET REMOTE_COMMAND")
child = subprocess.Popen(
    ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
     "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
     "-T", sys.argv[1], sys.argv[2]],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
)

def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError("SSH pipe closed")
        view = view[n:]

def send_input():
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            for start in range(0, len(data), 256):
                write_all(child.stdin.fileno(), data[start:start + 256])
                time.sleep(0.020)
    except OSError:
        pass
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass

def stop(signum, _frame):
    child.terminate()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
threading.Thread(target=send_input, daemon=True).start()
try:
    while True:
        data = os.read(child.stdout.fileno(), 65536)
        if not data:
            break
        write_all(1, data)
except OSError:
    pass
finally:
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
raise SystemExit(child.returncode or 0)
