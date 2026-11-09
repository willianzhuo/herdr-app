#!/usr/bin/env python3
"""Compare Unix SSH gateways using the same core and bounded no-op requests.

No terminal is attached or created. Payload bytes are an ignored shell comment;
the only remote program executed is `sh -c 'true # ...'`.
"""
import argparse
import json
import os
from pathlib import Path
import re
import select
import shlex
import struct
import subprocess
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", help="existing SSH alias or user@host")
    parser.add_argument("--gateway", help="override only SSH HostName")
    parser.add_argument("--port", type=int)
    parser.add_argument("--family", choices=["any", "4", "6"], default="any")
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--sizes", default="0,4096,16384")
    parser.add_argument("--report", type=Path, help="private JSON report (0600)")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.@:\[\]-]+", args.target) or args.target.startswith("-"):
        parser.error("use an SSH alias or user@host")
    if args.gateway and not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]+", args.gateway):
        parser.error("invalid gateway hostname")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("port must be 1–65535")
    if not 1 <= args.timeout <= 60:
        parser.error("timeout must be 1–60 seconds")
    try:
        sizes = [int(v) for v in args.sizes.split(",")]
        if not sizes or len(sizes) > 12 or any(v < 0 or v > 65536 for v in sizes):
            raise ValueError()
    except ValueError:
        parser.error("sizes must be 1–12 comma-separated integers from 0 to 65536")

    marker = "HERDR_CHECK_" + uuid.uuid4().hex
    command = "printf '%s\\n' " + shlex.quote(marker) + "; p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; exec \"$p\" connect"
    ssh = ["ssh", "-S", "none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T"]
    if args.family != "any":
        ssh += ["-" + args.family]
    if args.gateway:
        ssh += ["-o", "HostName=" + args.gateway]
    if args.port:
        ssh += ["-p", str(args.port)]
    ssh += [args.target, command]
    report = {"target":args.target, "gateway":args.gateway, "port":args.port, "samples":[]}
    child = None
    error = False
    with tempfile.TemporaryFile() as stderr:
        try:
            started = time.monotonic()
            child = subprocess.Popen(ssh, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=0)
            os.set_blocking(child.stdin.fileno(), False)

            def read(count, deadline):
                data = b""
                while len(data) < count:
                    if not select.select([child.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                        raise TimeoutError("SSH response timed out")
                    chunk = os.read(child.stdout.fileno(), count - len(data))
                    if not chunk:
                        raise EOFError("SSH channel closed")
                    data += chunk
                return data

            def line(deadline):
                data = b""
                while not data.endswith(b"\n"):
                    if len(data) > 1024 * 1024:
                        raise ValueError("oversized handshake")
                    data += read(1, deadline)
                return data

            def write(data, deadline):
                while data:
                    if not select.select([], [child.stdin], [], max(0, deadline - time.monotonic()))[1]:
                        raise TimeoutError("SSH input timed out")
                    count = os.write(child.stdin.fileno(), data)
                    if count <= 0:
                        raise OSError("SSH input closed")
                    data = data[count:]

            report["phase"] = "ssh_exec"
            if line(started + max(20, args.timeout)) != (marker + "\n").encode():
                raise ValueError("unexpected remote readiness reply")
            report["ssh_ready_ms"] = round((time.monotonic() - started) * 1000)
            report["phase"] = "peer_hello"
            hello = {"jsonrpc":"2.0", "id":0, "method":"hello", "params":{
                "generation":1, "framed":True, "calls_you":"ssh-check",
                "core":{"id":uuid.uuid4().hex, "name":"ssh-check"},
                "features":["framed", "attach", "events", "status", "shell", "resize_notifications", "automatic_input"],
            }}
            started = time.monotonic()
            deadline = started + args.timeout
            write((json.dumps(hello) + "\n").encode(), deadline)
            hello = json.loads(line(deadline))
            if "result" not in hello:
                raise ValueError("peer handshake failed: " + str(hello.get("error")))
            report["hello_ms"] = round((time.monotonic() - started) * 1000)
            report["core_id"] = hello["result"]["core"]["id"]
            report["core_version"] = hello["result"]["version"]
            for request_id, size in enumerate(sizes, 1):
                report["phase"] = "request_" + str(size)
                request = {"jsonrpc":"2.0", "id":request_id, "method":"machine.exec",
                    "params":{"argv":["sh", "-c", "true #" + "x" * size], "timeout":3}}
                data = json.dumps(request).encode()
                started = time.monotonic()
                deadline = started + args.timeout
                write(struct.pack("<IBI", 0, 0, len(data)) + data, deadline)
                channel, kind, length = struct.unpack("<IBI", read(9, deadline))
                if channel != 0 or kind != 0 or length > 8 * 1024 * 1024:
                    raise ValueError("unexpected RPC frame")
                response = json.loads(read(length, deadline))
                if response.get("id") != request_id or "error" in response:
                    raise ValueError("RPC failed: " + str(response.get("error")))
                result = response["result"]
                if result.get("code") != 0:
                    raise ValueError("remote no-op failed")
                report["samples"].append({"payload_bytes":size, "rtt_ms":round((time.monotonic() - started) * 1000), "remote_ms":result.get("ms")})
            report["phase"] = "complete"
        except (OSError, ValueError, EOFError, TimeoutError, KeyError) as exc:
            error = True
            report["error"] = str(exc)
        finally:
            if child is not None:
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            stderr.seek(0)
            if error:
                report["ssh_error"] = stderr.read(8192).decode(errors="replace")[-1200:]
    if args.report:
        fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    print(json.dumps(report, indent=2))
    return int(error)


if __name__ == "__main__":
    raise SystemExit(main())
