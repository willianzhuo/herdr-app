#!/usr/bin/env python3
"""SFTP downloads with core metadata/compatibility; no terminal input or SSH config."""
import base64
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

CHUNK = 1024 * 1024

# Run locally or via hc exec --json. Output is binary for read, JSON for prepare.
# The core's base64 envelope is decoded before any bytes reach the destination.
REMOTE = r'''import json, os, stat, sys, tarfile, tempfile
from pathlib import Path
r=json.loads(sys.argv[1])
token=r['id']
if len(token)!=32 or any(c not in '0123456789abcdef' for c in token): raise ValueError('Invalid download ID')
base=Path(tempfile.gettempdir())/('herdr-files-'+str(os.getuid() if hasattr(os,'getuid') else 'user'))
archive=base/(token+'.tar.gz')
marker=base/(token+'.probe')
def signature(s): return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]
def opened(path):
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NONBLOCK',0))
    f=os.fdopen(fd,'rb')
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        f.close();raise ValueError('Only regular files can be downloaded')
    return f
if r['op']=='cleanup':
    if base.is_symlink(): raise ValueError('Invalid temporary folder')
    archive.unlink(missing_ok=True)
    marker.unlink(missing_ok=True)
elif r['op']=='prepare':
    path=Path(r['path']);s=path.stat()
    if bool(r['directory'])!=stat.S_ISDIR(s.st_mode): raise ValueError('Source type changed; refresh Files and retry')
    if r['directory'] or r.get('sftp'):
        base.mkdir(mode=0o700,exist_ok=True)
        if base.is_symlink() or (hasattr(os,'getuid') and base.stat().st_uid!=os.getuid()): raise ValueError('Invalid temporary folder')
        base.chmod(0o700)
    if r['directory']:
        def regular(info):
            if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):
                raise ValueError('Folder contains a special file: '+info.name)
            return info
        try:
            with archive.open('xb') as out:
                with tarfile.open(fileobj=out,mode='w:gz',dereference=False) as tar:
                    tar.add(path.resolve(strict=True),arcname=path.name or 'root',filter=regular)
        except BaseException:
            archive.unlink(missing_ok=True);raise
        path=archive
    with opened(path) as f: s=os.fstat(f.fileno())
    if r.get('sftp'):
        with marker.open('x') as out: out.write(token)
        marker.chmod(0o600)
    print(json.dumps({'size':s.st_size,'signature':signature(s),'path':str(path.absolute()),'marker':str(marker) if r.get('sftp') else None}))
elif r['op']=='read':
    path=archive if r['directory'] else Path(r['path'])
    with opened(path) as f:
        if signature(os.fstat(f.fileno()))!=r['signature']: raise ValueError('Source changed during download; retry when it is stable')
        f.seek(r['offset']);data=f.read(r['length'])
        if signature(os.fstat(f.fileno()))!=r['signature']: raise ValueError('Source changed during download; retry when it is stable')
    sys.stdout.buffer.write(data)
else: raise ValueError('Unknown download operation')
'''


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        json.dump(value, f, ensure_ascii=False)
        temp = Path(f.name)
    try:
        temp.chmod(0o600)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def job_folder(home, job):
    if not isinstance(job, str) or not re.fullmatch(r'[a-f0-9]{32}', job):
        raise ValueError('Invalid download ID')
    root = Path(home) / 'file-downloads'
    return root / job


def filename(spec):
    windows = bool(re.match(r'^[A-Za-z]:[\\/]|^\\\\', spec['path']))
    path = spec['path'].rstrip('/\\') if windows else spec['path'].rstrip('/')
    name = PureWindowsPath(path).name if windows else Path(path).name
    if name in ('', '.', '..'):
        name = 'root'
    if '\0' in name:
        raise ValueError('Invalid filename')
    return name + '.tar.gz' if spec['directory'] else name


def sftp_quote(path):
    """OpenSSH batch quoted paths are literal, including glob characters."""
    if any(c in str(path) for c in '\0\r\n'):
        raise ValueError('This path needs Core compatibility mode')
    return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"') + '"'


def publish(temp, destination, name):
    # Link creates the final directory entry atomically and refuses all existing
    # files/symlinks. Concurrent downloads cannot overwrite each other.
    suffix = '.tar.gz' if name.endswith('.tar.gz') else Path(name).suffix
    stem = name[:-len(suffix)] if suffix else name
    for index in range(10000):
        target = destination / (name if index == 0 else f'{stem} ({index}){suffix}')
        try:
            os.link(temp, target)
            temp.unlink()
            return target
        except FileExistsError:
            continue
    raise RuntimeError('Too many files with this name in the destination')


class Download:
    def __init__(self, folder, spec, job):
        self.folder, self.spec, self.job = folder, spec, job
        self.state = {'id':job, 'phase':'preparing', 'bytes':0, 'total':None}

    def update(self, **values):
        self.state.update(values, updated=time.time())
        atomic_json(self.folder / 'state.json', self.state)

    def call(self, op, **args):
        request = {**self.spec, 'id':self.job, 'op':op, 'sftp':self.state.get('transport') == 'SFTP', **args}
        command = ['python3', '-c', REMOTE, json.dumps(request, ensure_ascii=False)]
        limit = 600 if op == 'prepare' and self.spec['directory'] else 60
        if self.spec.get('on'):
            command = [self.spec.get('core') or 'hc', 'exec', '--json', '--on', self.spec['on'],
                       '--timeout', str(limit), '--', *command]
        else:
            command[0] = sys.executable
        reply = subprocess.run(command, capture_output=True, timeout=limit + 15)
        if self.spec.get('on'):
            try:
                value = json.loads(reply.stdout or reply.stderr)
            except ValueError:
                raise RuntimeError('Core returned an invalid download response')
            if value.get('error'):
                raise RuntimeError(value['error'].get('message', 'Core request failed'))
            if value.get('timed_out') or value.get('truncated'):
                raise RuntimeError('Download request timed out or returned incomplete data')
            if reply.returncode or value.get('code') != 0:
                detail = base64.b64decode(value.get('stderr', ''), validate=True).decode('utf-8', 'replace')
                raise RuntimeError(detail.strip().splitlines()[-1] if detail.strip() else 'Cannot read the source')
            return base64.b64decode(value['stdout'], validate=True)
        if reply.returncode:
            detail = reply.stderr.decode('utf-8', 'replace').strip()
            raise RuntimeError(detail.splitlines()[-1] if detail else 'Cannot read the source')
        return reply.stdout

    def select_transport(self):
        if not self.spec.get('on'):
            self.update(transport='Local')
            return None
        reason = None
        if self.spec.get('transport') == 'core':
            reason = '已选择兼容模式'
        elif not shutil.which('sftp'):
            reason = '本机没有 SFTP 客户端'
        elif any(c in self.spec['path'] + self.spec['destination'] + str(self.folder) for c in '\r\n'):
            reason = '路径包含批处理不支持的换行符'
        elif re.match(r'^[A-Za-z]:[\\/]|^\\\\', self.spec['path']):
            reason = '此源路径使用 Windows 格式'
        if not reason:
            reply = subprocess.run([self.spec.get('core') or 'hc', 'machine', 'ls', '--json'], capture_output=True, timeout=15)
            if reply.returncode:
                raise RuntimeError('Cannot inspect this machine’s SSH route')
            inventory = json.loads(reply.stdout)
            rows = inventory if isinstance(inventory, list) else inventory.get('machines', [])
            machine = next((m for m in rows if m.get('name') == self.spec['on']), None)
            if not machine:
                raise RuntimeError('The source machine is no longer configured')
            target = machine.get('target') or ''
            # Never guess that a core's --via command is a usable SSH hostname.
            if machine.get('via') or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]*', target):
                reason = '此连接没有可直接使用的 SSH 目标'
            else:
                self.update(transport='SFTP')
                return target
        self.update(transport='Core', transportDetail=reason)
        return None

    def sftp_command(self, target):
        return ['sftp', '-b', '-', '-R', '64', '-oBatchMode=yes', '-oConnectTimeout=15',
                '-oServerAliveInterval=15', '-oServerAliveCountMax=3', target]

    def transfer_sftp(self, target, meta, temp):
        probe = temp.parent / 'route.probe'
        batch = (f'get {sftp_quote(meta["marker"])} {sftp_quote(probe)}\n'
                 f'get {sftp_quote(meta["path"])} {sftp_quote(temp)}\nquit\n')
        command = self.sftp_command(target)
        last_progress = time.monotonic()
        received = -1
        self.update(phase='connecting')
        with (self.folder / 'sftp.log').open('wb') as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log)
            try:
                process.stdin.write(batch.encode('utf-8'))
                process.stdin.close()
                while process.poll() is None:
                    size = temp.stat().st_size if temp.exists() else 0
                    if size > meta['size']:
                        raise RuntimeError('Source grew during download; no final file was saved')
                    if size != received:
                        received = size
                        last_progress = time.monotonic()
                        self.update(bytes=size, phase='downloading' if probe.exists() else 'connecting')
                    if time.monotonic() - last_progress > 120:
                        raise RuntimeError('SFTP made no progress for 120 seconds')
                    time.sleep(.2)
                if process.returncode:
                    log.flush()
                    with (self.folder / 'sftp.log').open('rb') as errors:
                        errors.seek(max(0, errors.seek(0, 2) - 1200))
                        detail = errors.read().decode('utf-8', 'replace').strip()
                    raise RuntimeError('SFTP download failed: ' + (detail or 'connection closed'))
                if not probe.exists() or probe.read_text() != self.job:
                    raise RuntimeError('SFTP target differs from the configured Core route')
                if not temp.exists() or temp.stat().st_size != meta['size']:
                    raise RuntimeError('SFTP returned incomplete data; no final file was saved')
                self.update(bytes=meta['size'], phase='verifying')
            finally:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()

    def run(self):
        temporary = None
        try:
            destination = Path(self.spec['destination']).expanduser()
            if not destination.is_dir():
                raise ValueError('Choose an existing local destination folder')
            target = self.select_transport()
            self.update(phase='packing' if self.spec['directory'] else 'preparing')
            meta = json.loads(self.call('prepare'))
            size = meta['size']
            if not isinstance(size, int) or size < 0:
                raise ValueError('Invalid source size')
            self.update(total=size)
            # OpenSSH writes only inside a private directory, even when the user
            # chooses a shared destination. No other user can replace its paths.
            temporary = Path(tempfile.mkdtemp(dir=destination, prefix='.herdr-download-'))
            temp = temporary / 'payload.part'
            temp.touch(mode=0o600)
            if target:
                self.transfer_sftp(target, meta, temp)
            with temp.open('r+b' if target else 'w+b') as out:
                digest, received = hashlib.sha256(), 0
                self.update(phase='verifying' if target else 'downloading', total=size)
                while received < size:
                    length = min(CHUNK, size - received)
                    chunk = out.read(length) if target else self.call('read', signature=meta['signature'], offset=received, length=length)
                    if len(chunk) != length:
                        raise RuntimeError('Source returned incomplete data; no final file was saved')
                    if not target:
                        out.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                    if not target:
                        self.update(bytes=received)
                # Revalidate even empty files and the final chunk before publishing.
                self.call('read', signature=meta['signature'], offset=size, length=0)
                out.flush()
                os.fsync(out.fileno())
            target = publish(temp, destination, filename(self.spec))
            self.update(phase='finishing', path=str(target), sha256=digest.hexdigest())
        except Exception as e:
            self.update(phase='error', error=str(e)[-1400:])
        finally:
            if temporary:
                try:
                    shutil.rmtree(temporary)
                except OSError as e:
                    self.update(cleanupWarning='Partial file cleanup failed: ' + str(e)[-300:])
            if self.spec['directory'] or self.state.get('transport') == 'SFTP':
                try:
                    self.call('cleanup')
                except Exception as e:
                    self.update(cleanupWarning='Temporary archive cleanup failed: ' + str(e)[-300:])
        if self.state['phase'] == 'finishing':
            self.update(phase='complete')
        return self.state


def start(home, spec):
    if not isinstance(spec.get('path'), str) or not spec['path'] or '\0' in spec['path']:
        raise ValueError('Invalid source path')
    if spec.get('on') is not None and (not isinstance(spec['on'], str) or not spec['on']):
        raise ValueError('Invalid machine')
    if not isinstance(spec.get('directory'), bool):
        raise ValueError('Invalid source type')
    if not Path(spec['destination']).expanduser().is_dir():
        raise ValueError('Choose an existing local destination folder')
    job = uuid.uuid4().hex
    folder = job_folder(home, job)
    folder.mkdir(mode=0o700, parents=True)
    atomic_json(folder / 'request.json', spec)
    state = {'id':job, 'phase':'queued', 'bytes':0, 'total':None}
    atomic_json(folder / 'state.json', state)
    try:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', home, job],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, close_fds=True)
        threading.Thread(target=child.wait, daemon=True).start()
    except Exception as e:
        state.update(phase='error', error=str(e))
        atomic_json(folder / 'state.json', state)
    return state


def main():
    op, home, value = sys.argv[1:4]
    if op == 'start':
        return start(home, json.loads(value))
    folder = job_folder(home, value)
    if op == 'status':
        return json.loads((folder / 'state.json').read_text())
    if op == 'worker':
        return Download(folder, json.loads((folder / 'request.json').read_text()), value).run()
    raise ValueError('Unknown download operation')


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)}, ensure_ascii=False))
        sys.exit(1)
