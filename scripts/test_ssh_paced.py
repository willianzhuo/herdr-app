"""Exercise the transport with an isolated delayed SSH exec channel."""
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("ssh-paced.py")
# Real pipes and shell quoting, but no network, core or user terminals. A gateway
# rejects pre-auth input and bursts that coalesce above 256 bytes in 40 ms.
LAUNCH = r'''
import runpy, subprocess, sys
original = subprocess.Popen
mode = sys.argv[1]
def fake_ssh(args, **kwargs):
    assert args[0] == '/usr/bin/ssh'
    remote = args[-1]
    if mode == 'bad-ready':
        remote = "printf 'wrong readiness\\n'"
    gate = r"""
import os,select,sys,time,subprocess
if select.select([0],[],[],.2)[0]:sys.exit(42)
p=subprocess.Popen(['/bin/sh','-c',sys.argv[1]],stdin=subprocess.PIPE)
try:
 while True:
  data=os.read(0,65536)
  if not data:break
  time.sleep(.04)
  while select.select([0],[],[],0)[0]:
   more=os.read(0,65536)
   if not more:break
   data+=more
  if len(data)>256:sys.exit(43)
  p.stdin.write(data);p.stdin.flush()
 p.stdin.close();sys.exit(p.wait(timeout=3))
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=3)
"""
    return original([sys.executable, '-c', gate, remote], **kwargs)
subprocess.Popen = fake_ssh
sys.argv = [sys.argv[2], 'fixture', sys.argv[3]]
runpy.run_path(sys.argv[0], run_name='__main__')
'''


class TransportTest(unittest.TestCase):
    def run_transport(self, command, data=b"", mode="ready"):
        return subprocess.run(
            [sys.executable, "-c", LAUNCH, mode, str(SCRIPT), command],
            input=data, capture_output=True, timeout=8,
        )

    def test_waits_for_exec_and_preserves_binary_bytes(self):
        data = bytes(range(256)) * 16
        result = self.run_transport("exec cat", data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, data)
        self.assertIn(b"remote channel ready", result.stderr)
        self.assertNotIn(data[:32], result.stderr)

    def test_initial_peer_hello_over_256_bytes_is_delivered(self):
        # A connection can fail before anyone types: the core's peer hello
        # itself crosses the affected gateway's small-burst boundary.
        data = b'{"method":"hello","padding":"' + b'x' * 268 + b'"}\n'
        result = self.run_transport("exec cat", data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, data)

    def test_remote_command_quoting_and_exit_status(self):
        result = self.run_transport("printf '%s' \"a 'quote' and $dollar\"; exit 7")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout, b"a 'quote' and ")

    def test_bad_ready_never_reaches_protocol_stdout(self):
        result = self.run_transport("exec cat", b"private input", "bad-ready")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertIn(b"unexpected remote SSH readiness reply", result.stderr)


if __name__ == "__main__":
    unittest.main()
