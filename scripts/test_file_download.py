"""Download real bytes and archives without touching user files or terminals."""
import base64
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'defaults/mods/file-download/download.py'
spec = importlib.util.spec_from_file_location('file_download', MODULE)
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)
SFTP = shutil.which('sftp')
SFTP_SERVER = next((p for p in ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'] if Path(p).is_file()), None)


class DirectSftp(download.Download):
    """Exercise real OpenSSH SFTP over stdio without a user SSH connection."""
    def select_transport(self):
        self.update(transport='SFTP')
        return 'fixture'

    def sftp_command(self, target):
        return [SFTP, '-D', SFTP_SERVER, '-b', '-', '-R', '64']


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix='herdr-download-test-')
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.dest = self.root / 'destination'
        self.dest.mkdir()
        self.count = 0

    def job(self, source, directory=False, cls=download.Download, **values):
        self.count += 1
        ident = f'{self.count:032x}'
        folder = self.root / ('job-' + ident)
        folder.mkdir()
        return cls(folder, {'path':str(source), 'destination':str(self.dest),
                            'directory':directory, 'on':None, **values}, ident)

    def test_binary_and_empty_files_keep_exact_bytes_and_never_overwrite(self):
        source = self.root / "中文 O'Brien $(touch OWNED).bin"
        data = bytes(range(256)) * (download.CHUNK // 128 + 1)
        source.write_bytes(data)
        (self.dest / source.name).write_bytes(b'existing')
        first = self.job(source).run()
        self.assertEqual(first['phase'], 'complete', first)
        self.assertEqual(Path(first['path']).read_bytes(), data)
        self.assertEqual((self.dest / source.name).read_bytes(), b'existing')
        second = self.job(source).run()
        self.assertNotEqual(first['path'], second['path'])
        self.assertEqual(Path(second['path']).read_bytes(), data)
        source.write_bytes(b'')
        empty = self.job(source).run()
        self.assertEqual(empty['phase'], 'complete', empty)
        self.assertEqual(Path(empty['path']).read_bytes(), b'')
        self.assertFalse((self.root / 'OWNED').exists())
        self.assertFalse(list(self.dest.glob('.herdr-download-*.part')))
        self.assertEqual(download.filename({'path':'/work/literal\\', 'directory':False}), 'literal\\')
        self.assertEqual(download.filename({'path':'C:\\Work\\中文.bin', 'directory':False}), '中文.bin')

    def test_destination_symlink_is_preserved_and_folder_archive_keeps_unicode_and_links(self):
        folder = self.root / '资料'
        folder.mkdir()
        (folder / '空文件').write_bytes(b'')
        (folder / '图片.bin').write_bytes(bytes(range(256)))
        (folder / 'loop').symlink_to(folder, target_is_directory=True)
        protected = self.root / 'protected'
        protected.write_bytes(b'keep')
        (self.dest / '资料.tar.gz').symlink_to(protected)
        job = self.job(folder, directory=True)
        state = job.run()
        self.assertEqual(state['phase'], 'complete', state)
        self.assertEqual(protected.read_bytes(), b'keep')
        self.assertTrue((self.dest / '资料.tar.gz').is_symlink())
        with tarfile.open(state['path']) as archive:
            self.assertEqual(archive.extractfile('资料/图片.bin').read(), bytes(range(256)))
            self.assertEqual(archive.extractfile('资料/空文件').read(), b'')
            self.assertTrue(archive.getmember('资料/loop').issym())
        temp = Path(tempfile.gettempdir()) / ('herdr-files-' + str(os.getuid())) / (job.job + '.tar.gz')
        self.assertFalse(temp.exists(), 'temporary archive must be removed')

    def test_mutating_source_fails_without_publishing_partial_output(self):
        source = self.root / 'changing.bin'
        source.write_bytes(b'a' * (download.CHUNK + 10))
        class Changing(download.Download):
            def call(inner, op, **args):
                if op == 'read' and args['offset']:
                    source.write_bytes(b'changed')
                return super().call(op, **args)
        state = self.job(source, cls=Changing).run()
        self.assertEqual(state['phase'], 'error')
        self.assertIn('Source changed', state['error'])
        self.assertFalse(list(self.dest.iterdir()))

    def test_missing_sources_and_special_files_fail_cleanly(self):
        self.assertEqual(self.job(self.root / 'missing').run()['phase'], 'error')
        pipe = self.root / 'pipe'
        os.mkfifo(pipe)
        state = self.job(pipe).run()
        self.assertEqual(state['phase'], 'error')
        self.assertIn('regular files', state['error'])
        directory = self.root / 'special'
        directory.mkdir()
        os.mkfifo(directory / 'pipe')
        state = self.job(directory, directory=True).run()
        self.assertEqual(state['phase'], 'error')
        self.assertIn('special file', state['error'])
        self.assertFalse(list(self.dest.iterdir()))

    def test_remote_transfer_decodes_core_binary_envelope_and_preserves_exact_machine(self):
        source = self.root / 'raw.bin'
        source.write_bytes(bytes(range(256)) * 10)
        original_run = subprocess.run
        calls = []
        def core(argv, **kwargs):
            calls.append(argv)
            self.assertEqual(argv[:6], ['/test/hc', 'exec', '--json', '--on', 'remote alias', '--timeout'])
            self.assertEqual(argv[7], '--')
            result = original_run([sys.executable, *argv[9:]], **kwargs)
            value = {'code':result.returncode, 'stdout':base64.b64encode(result.stdout).decode(),
                     'stderr':base64.b64encode(result.stderr).decode(), 'timed_out':False, 'truncated':False}
            return subprocess.CompletedProcess(argv, 0, json.dumps(value).encode(), b'')
        with patch.object(download.subprocess, 'run', core):
            state = self.job(source, on='remote alias', core='/test/hc', transport='core').run()
        self.assertEqual(state['phase'], 'complete', state)
        self.assertEqual(Path(state['path']).read_bytes(), source.read_bytes())
        self.assertEqual(len(calls), 3)

    def test_truncated_core_response_and_short_chunks_never_succeed(self):
        bad = {'code':0, 'stdout':'', 'stderr':'', 'truncated':True}
        with patch.object(download.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(bad).encode(), b'')):
            state = self.job('/remote/file', on='remote').run()
        self.assertEqual(state['phase'], 'error')
        class Short(download.Download):
            def call(self, op, **args):
                return b'{"size":10,"signature":[]}' if op == 'prepare' else b'short'
        state = self.job('/remote/file', cls=Short).run()
        self.assertEqual(state['phase'], 'error')
        self.assertIn('incomplete', state['error'])
        self.assertFalse(list(self.dest.iterdir()))

    def test_real_worker_finishes_independently_of_ui_and_status_rejects_invalid_id(self):
        source = self.root / 'worker.bin'
        source.write_bytes(os.urandom(4096))
        state = download.start(str(self.root), {'path':str(source), 'on':None, 'directory':False, 'destination':str(self.dest)})
        state_path = download.job_folder(str(self.root), state['id']) / 'state.json'
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = json.loads(state_path.read_text())
            if state['phase'] in ['complete', 'error']:
                break
            time.sleep(.03)
        self.assertEqual(state['phase'], 'complete', state)
        self.assertEqual(Path(state['path']).read_bytes(), source.read_bytes())
        with self.assertRaises(ValueError):
            download.job_folder(str(self.root), '../outside')

    @unittest.skipUnless(SFTP and SFTP_SERVER, 'requires OpenSSH SFTP client/server')
    def test_real_sftp_stream_preserves_literal_globs_quotes_unicode_and_binary_bytes(self):
        data = bytes(range(256)) * (download.CHUNK // 128 + 1)
        for name in ["中文 O'Brien $a.bin", 'star* [x]? "quotes".bin', 'literal\\name.bin']:
            source = self.root / name
            source.write_bytes(data)
            (self.root / 'starXXX xQ "quotes".bin').write_bytes(b'wrong')
            (self.dest / name).write_bytes(b'keep')
            job = self.job(source, cls=DirectSftp)
            state = job.run()
            self.assertEqual(state['phase'], 'complete', state)
            self.assertEqual(state['transport'], 'SFTP')
            self.assertEqual(Path(state['path']).read_bytes(), data)
            self.assertEqual((self.dest / name).read_bytes(), b'keep')
            self.assertEqual(Path(state['path']).stat().st_mode & 0o777, 0o600)
            marker = Path(tempfile.gettempdir()) / ('herdr-files-' + str(os.getuid())) / (job.job + '.probe')
            self.assertFalse(marker.exists())
        self.assertFalse(list(self.dest.glob('.herdr-download-*')))

    @unittest.skipUnless(SFTP and SFTP_SERVER, 'requires OpenSSH SFTP client/server')
    def test_real_sftp_folder_archive_and_post_transfer_source_validation(self):
        source = self.root / 'folder'
        source.mkdir()
        (source / 'child').write_bytes(os.urandom(8192))
        state = self.job(source, directory=True, cls=DirectSftp).run()
        self.assertEqual(state['phase'], 'complete', state)
        with tarfile.open(state['path']) as archive:
            self.assertEqual(archive.extractfile('folder/child').read(), (source / 'child').read_bytes())
        original = self.root / 'changed'
        original.write_bytes(b'original')
        class ChangeAfter(DirectSftp):
            def transfer_sftp(inner, target, meta, temp):
                super().transfer_sftp(target, meta, temp)
                original.write_bytes(b'new content')
        state = self.job(original, cls=ChangeAfter).run()
        self.assertEqual(state['phase'], 'error', state)
        self.assertIn('Source changed', state['error'])
        self.assertFalse((self.dest / original.name).exists())

    @unittest.skipUnless(SFTP and SFTP_SERVER, 'requires OpenSSH SFTP client/server')
    def test_sftp_failure_or_mismatched_route_never_publishes_or_silently_falls_back(self):
        source = self.root / 'source'
        source.write_bytes(b'wanted')
        class Fail(DirectSftp):
            def sftp_command(self, target):
                return [sys.executable, '-c', 'import sys;sys.stdin.read();sys.exit(1)']
            def call(inner, op, **args):
                if op == 'read' and args.get('length'):
                    raise AssertionError('must not silently fall back to Core data reads')
                return super().call(op, **args)
        state = self.job(source, cls=Fail).run()
        self.assertEqual(state['phase'], 'error', state)
        self.assertIn('SFTP download failed', state['error'])
        class WrongRoute(DirectSftp):
            def call(inner, op, **args):
                value = super().call(op, **args)
                if op == 'prepare':
                    Path(json.loads(value)['marker']).write_text('different route')
                return value
        state = self.job(source, cls=WrongRoute).run()
        self.assertEqual(state['phase'], 'error', state)
        self.assertIn('differs from', state['error'])
        self.assertFalse(list(self.dest.iterdir()))

    def test_transport_selection_uses_exact_core_target_and_explains_compatibility(self):
        job = self.job('/remote/file', on='machine')
        with patch.object(download.shutil, 'which', return_value='/usr/bin/sftp'):
            for machine, wanted in [({'name':'machine','target':'ssh-alias','via':False}, 'ssh-alias'),
                                    ({'name':'machine','target':'ssh command','via':True}, None)]:
                reply = subprocess.CompletedProcess([], 0, json.dumps({'machines':[machine]}).encode(), b'')
                with patch.object(download.subprocess, 'run', return_value=reply):
                    self.assertEqual(job.select_transport(), wanted)
                self.assertEqual(job.state['transport'], 'SFTP' if wanted else 'Core')
                if not wanted:
                    self.assertTrue(job.state['transportDetail'])
            explicit = self.job('/remote/file', on='machine', transport='core')
            with patch.object(download.subprocess, 'run', side_effect=AssertionError('no route probe for explicit compatibility mode')):
                self.assertIsNone(explicit.select_transport())
            self.assertEqual(explicit.state['transport'], 'Core')


if __name__ == '__main__':
    unittest.main()
