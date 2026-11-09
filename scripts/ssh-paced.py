#!/usr/bin/python3
"""Transparent paced SSH transport for input-burst compatibility.

Usage: ssh-paced.py SSH_TARGET REMOTE_COMMAND. Herdr appends the command. Forward every byte unchanged; pace only
stdin in 128-byte pieces at 50 ms intervals. Remote output is not throttled.
The existing herdr-core supervisor remains responsible for reconnection.
"""
import os
import select
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid

if len(sys.argv) != 3:
    raise SystemExit("usage: ssh-paced.py SSH_TARGET REMOTE_COMMAND")
# Pacing before authentication just fills ssh's local buffer: the gateway still
# receives a burst when the exec channel opens. Wait for that channel first.
ready = ("HERDR_SSH_READY_" + uuid.uuid4().hex + "\n").encode()
remote = "printf '%s\\n' " + shlex.quote(ready.decode().strip()) + "; exec sh -c " + shlex.quote(sys.argv[2])
child = subprocess.Popen(
    ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
     "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
     "-T", sys.argv[1], remote],
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
            # Even the core's initial peer hello is >256 bytes. A 20 ms gap
            # still coalesces into a burst on affected gateways; 50 ms does not.
            for start in range(0, len(data), 128):
                write_all(child.stdin.fileno(), data[start:start + 128])
                time.sleep(0.050)
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
failed = False
try:
    deadline = time.monotonic() + 30
    for expected in ready:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([child.stdout], [], [], remaining)[0]:
            raise OSError("remote SSH channel did not become ready within 30 s")
        if os.read(child.stdout.fileno(), 1) != bytes([expected]):
            raise OSError("unexpected remote SSH readiness reply")
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ssh-paced:", sys.argv[1], "remote channel ready", file=sys.stderr, flush=True)
    threading.Thread(target=send_input, daemon=True).start()
    while True:
        data = os.read(child.stdout.fileno(), 65536)
        if not data:
            break
        write_all(1, data)
except OSError as error:
    failed = True
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ssh-paced:", sys.argv[1], str(error), file=sys.stderr, flush=True)
finally:
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
raise SystemExit(1 if failed else (child.returncode or 0))
