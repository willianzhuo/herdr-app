#!/usr/bin/env python3
"""Binary downloads through the existing core route; no terminal input or SSH config."""
import base64
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
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
elif r['op']=='prepare':
    path=Path(r['path']);s=path.stat()
    if bool(r['directory'])!=stat.S_ISDIR(s.st_mode): raise ValueError('Source type changed; refresh Files and retry')
    if r['directory']:
        base.mkdir(mode=0o700,exist_ok=True)
        if base.is_symlink() or (hasattr(os,'getuid') and base.stat().st_uid!=os.getuid()): raise ValueError('Invalid temporary folder')
        base.chmod(0o700)
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
    print(json.dumps({'size':s.st_size,'signature':signature(s)}))
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
        request = {**self.spec, 'id':self.job, 'op':op, **args}
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

    def run(self):
        temp = None
        try:
            destination = Path(self.spec['destination']).expanduser()
            if not destination.is_dir():
                raise ValueError('Choose an existing local destination folder')
            self.update(phase='packing' if self.spec['directory'] else 'preparing')
            meta = json.loads(self.call('prepare'))
            size = meta['size']
            if not isinstance(size, int) or size < 0:
                raise ValueError('Invalid source size')
            with tempfile.NamedTemporaryFile(dir=destination, prefix='.herdr-download-', suffix='.part', delete=False) as out:
                temp = Path(out.name)
                digest, received = hashlib.sha256(), 0
                self.update(phase='downloading', total=size)
                while received < size:
                    length = min(CHUNK, size - received)
                    chunk = self.call('read', signature=meta['signature'], offset=received, length=length)
                    if len(chunk) != length:
                        raise RuntimeError('Source returned incomplete data; no final file was saved')
                    out.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                    self.update(bytes=received)
                # Revalidate even empty files and the final chunk before publishing.
                self.call('read', signature=meta['signature'], offset=size, length=0)
                out.flush()
                os.fsync(out.fileno())
            target = publish(temp, destination, filename(self.spec))
            temp = None
            self.update(phase='finishing', path=str(target), sha256=digest.hexdigest())
        except Exception as e:
            self.update(phase='error', error=str(e)[-1400:])
        finally:
            if temp:
                temp.unlink(missing_ok=True)
            if self.spec['directory']:
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
