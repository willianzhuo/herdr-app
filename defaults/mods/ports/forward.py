#!/usr/bin/env python3
"""Private local SSH forwarding manager for the Ports mod (stdlib only)."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

# Inspect listeners belonging to this machine's Herdr terminal process trees.
# No screen scraping, input, root access or remote installation is involved.
PROBE = r'''import json, os, socket, sys
from pathlib import Path
roots = set(json.loads(sys.argv[1]))
procs = {}
for p in Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        if p.stat().st_uid != os.getuid(): continue
        s = (p/'stat').read_text().rsplit(')',1)[1].split()
        procs[int(p.name)] = int(s[1])
    except (OSError, ValueError, IndexError): pass
allowed = set(roots)
for _ in range(64):
    more = {pid for pid,parent in procs.items() if parent in allowed}
    if more <= allowed: break
    allowed |= more
owners = {}
for pid in allowed:
    p = Path('/proc')/str(pid)
    try:
        name = (p/'comm').read_text().strip()
        if name in ('ssh','sshd','hc','herdr-core','claude','codex','traex','traecli'): continue
        for fd in (p/'fd').iterdir():
            try:
                target = os.readlink(fd)
                if target.startswith('socket:['): owners[target[8:-1]] = (pid,name)
            except OSError: pass
    except OSError: pass
ports = {}
for family,table in [(socket.AF_INET,'tcp'),(socket.AF_INET6,'tcp6')]:
    try: lines = Path('/proc/net/'+table).read_text().splitlines()[1:]
    except OSError: continue
    for line in lines:
        f = line.split()
        if len(f)<10 or f[3]!='0A' or f[9] not in owners: continue
        raw,port = f[1].split(':'); port=int(port,16)
        if port<1024: continue
        if family==socket.AF_INET:
            host=socket.inet_ntop(family,bytes.fromhex(raw)[::-1])
        else:
            raw=bytes.fromhex(raw);host=socket.inet_ntop(family,b''.join(raw[i:i+4][::-1] for i in range(0,16,4)))
        host={'0.0.0.0':'127.0.0.1','::':'::1'}.get(host,host)
        pid,name=owners[f[9]]
        # Prefer IPv4 for a dual-stack service on the same port.
        if port not in ports or family==socket.AF_INET:
            ports[port]={'port':port,'host':host,'pid':pid,'process':name}
print(json.dumps(list(ports.values())[:64]))
'''


def valid_port(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("Use a TCP port from 1 to 65535")
    return value


def valid_target(value):
    if not isinstance(value, str) or value.startswith('-') or not re.fullmatch(r'[A-Za-z0-9_.@:\[\]-]{1,240}', value):
        raise ValueError("Use an SSH config alias or user@host")
    return value


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode='w') as f:
        json.dump(value, f); f.write('\n'); staged=Path(f.name)
    staged.chmod(0o600); staged.replace(path)


class Manager:
    def __init__(self, home, runtime):
        self.home, self.runtime = home, runtime
        self.folder = home/'port-forwarding'; self.folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.config_path = self.folder/'config.json'
        try: self.config=json.loads(self.config_path.read_text())
        except (OSError,ValueError): self.config={}
        for k in ('auto','targets','manual','locals'): self.config.setdefault(k,{})
        self.config.setdefault('ignored',[])
        self.lock=threading.RLock(); self.active=None; self.pids={}; self.core='hc'
        self.machines={}; self.candidates={}; self.scan_errors={}; self.rows=[]
        self.masters={}; self.forwarded={}; self.errors={}; self.retry={}; self.inventory_at=0
        self.last_sync=time.monotonic(); self.closed=False

    def request(self, data):
        with self.lock:
            op=data.get('op','status'); machine=data.get('machine')
            if op in ('auto','target','forward','stop','stop-all') and (not isinstance(machine,str) or not machine or len(machine)>128):
                raise ValueError('Select a registered machine')
            if op=='sync':
                self.active=data.get('active'); self.pids=data.get('pids',{})
                self.core=data.get('core') or 'hc'; self.last_sync=time.monotonic()
            elif op=='auto': self.config['auto'][machine]=bool(data['enabled'])
            elif op=='target':
                self.config['targets'][machine]=valid_target(data['target']); self.inventory_at=0
            elif op in ('forward','stop'):
                port=valid_port(data.get('port')); key=f'{machine}:{port}'
                self.config['ignored']=[k for k in self.config['ignored'] if k!=key]
                if op=='forward':
                    found=next((r for r in self.candidates.get(machine,[]) if r['port']==port),{})
                    self.config['manual'][key]={'machine':machine,'port':port,'host':found.get('host','127.0.0.1'),'process':found.get('process','Manual')}
                else:
                    self.config['manual'].pop(key,None); self.config['ignored'].append(key)
            elif op=='stop-all':
                keys={r['key'] for r in self.rows if r['machine']==machine}
                self.config['manual']={k:r for k,r in self.config['manual'].items() if r['machine']!=machine}
                self.config['ignored']=sorted(set(self.config['ignored'])|keys)
            elif op=='shutdown': self.closed=True
            elif op!='status': raise ValueError('Unknown Ports operation')
            if op not in ('sync','status','shutdown'): atomic_json(self.config_path,self.config)
            return self.snapshot()

    def snapshot(self):
        return {'machines':list(self.machines.values()),'rows':list(self.rows),
                'auto':dict(self.config['auto']),'scanErrors':dict(self.scan_errors)}

    def inventory(self):
        r=subprocess.run([self.core,'machine','ls','--json'],capture_output=True,text=True,timeout=6)
        if r.returncode: raise RuntimeError('Cannot read registered machines')
        machines={}
        for m in json.loads(r.stdout).get('machines',[]):
            target=self.config['targets'].get(m['name']) or (None if m.get('via') else m.get('target'))
            try: target=valid_target(target)
            except ValueError: target=None
            machines[m['name']]={'name':m['name'],'target':target,'state':m.get('state'),'via':m.get('via',False)}
        with self.lock: self.machines=machines

    def scan(self, name):
        with self.lock: pids=list(self.pids.get(name,[]))[:256]
        r=subprocess.run([self.core,'exec','--on',name,'--timeout','6','python3','-c',PROBE,json.dumps(pids)],capture_output=True,text=True,timeout=8)
        if r.returncode: raise RuntimeError('Port discovery unavailable; existing forwards retained')
        rows=json.loads(r.stdout)
        if not isinstance(rows,list): raise ValueError('Invalid port discovery response')
        return [{**r,'machine':name} for r in rows if isinstance(r,dict) and isinstance(r.get('port'),int)]

    def control(self, master, op, spec=None):
        args=['ssh','-S',str(master['socket']),'-o','BatchMode=yes','-O',op]
        if spec: args+=['-o','ExitOnForwardFailure=yes','-L',spec]
        args+=[master['target']]
        return subprocess.run(args,capture_output=True,text=True,timeout=5)

    def master(self, name, target):
        m=self.masters.get(name)
        if m and m['target']==target and m['process'].poll() is None: return m
        if m: self.stop_master(name)
        if time.monotonic()<self.retry.get(name,0): return None
        sock=self.runtime/('ssh-'+hashlib.sha256(name.encode()).hexdigest()[:12])
        if sock.exists():
            try: self.control({'socket':sock,'target':target},'exit')
            except (OSError,subprocess.SubprocessError): pass
            sock.unlink(missing_ok=True)
        log=self.folder/('ssh-'+hashlib.sha256(name.encode()).hexdigest()[:12]+'.log')
        # This master belongs only to Ports; never attach to or close core's SSH.
        args=['ssh','-M','-S',str(sock),'-N','-T','-o','ControlMaster=yes','-o','ControlPersist=no',
              '-o','ClearAllForwardings=yes','-o','BatchMode=yes',
              '-o','ConnectTimeout=5','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',target]
        with log.open('w') as f: child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=f,start_new_session=True)
        m={'socket':sock,'target':target,'process':child,'log':log};self.masters[name]=m
        self.retry[name]=time.monotonic()+10
        return m

    def stop_master(self, name):
        m=self.masters.pop(name,None)
        if not m: return
        p=m['process']
        if p.poll() is None:
            p.terminate()
            try: p.wait(timeout=2)
            except subprocess.TimeoutExpired: p.kill();p.wait(timeout=2)
        m['socket'].unlink(missing_ok=True)
        for k in list(self.forwarded):
            if self.forwarded[k]['machine']==name: del self.forwarded[k]

    @staticmethod
    def free_port(preferred):
        for port in [preferred,0]:
            try:
                with socket.socket() as s:
                    s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                    s.bind(('127.0.0.1',port));return s.getsockname()[1]
            except OSError: pass
        raise RuntimeError('No local port available')

    @staticmethod
    def spec(row):
        host=row['host']
        if ':' in host: host='['+host+']'
        return f"127.0.0.1:{row['local']}:{host}:{row['port']}"

    def reconcile(self):
        with self.lock:
            desired={}
            for name,rows in self.candidates.items():
                if self.config['auto'].get(name,True):
                    for row in rows: desired[f"{name}:{row['port']}"]={**row,'manual':False}
            desired.update({k:{**r,'manual':True} for k,r in self.config['manual'].items()})
            desired={k:r for k,r in desired.items() if k not in self.config['ignored'] and r['machine'] in self.machines}
        for key,row in list(self.forwarded.items()):
            if key not in desired or desired[key]['host']!=row['host']:
                m=self.masters.get(row['machine'])
                if m:
                    try: self.control(m,'cancel',self.spec(row))
                    except (OSError,subprocess.SubprocessError): pass
                self.forwarded.pop(key,None)
        rows=[]
        for key,row in desired.items():
            name=row['machine'];target=self.machines[name]['target'];state='Connecting';error=''
            if not target: state='SSH target required';error='Custom transport: enter its SSH config alias'
            else:
                try:
                    m=self.master(name,target)
                    if key in self.forwarded and m and m['process'].poll() is None:
                        row=self.forwarded[key];state='Forwarded'
                    elif m and m['socket'].exists():
                        preferred=self.config['locals'].get(key,row['port'] if row['port']>=1024 else 0)
                        for _ in range(3):
                            local=self.free_port(preferred);candidate={**row,'local':local}
                            reply=self.control(m,'forward',self.spec(candidate))
                            if reply.returncode==0:
                                row=candidate;self.forwarded[key]=row;state='Forwarded'
                                with self.lock:
                                    if self.config['locals'].get(key)!=local:
                                        self.config['locals'][key]=local;atomic_json(self.config_path,self.config)
                                break
                            error=reply.stderr.strip()[-240:];preferred=0
                        else: state='Error'
                    elif m and m['process'].poll() is not None:
                        state='Reconnecting';error=m['log'].read_text(errors='replace')[-240:]
                except (OSError,ValueError,subprocess.SubprocessError) as e: state='Error';error=str(e)[-240:]
            rows.append({**row,'key':key,'state':state,'error':error,'url':f"http://127.0.0.1:{row['local']}" if state=='Forwarded' else None})
        for name in list(self.masters):
            if not any(r['machine']==name for r in desired.values()): self.stop_master(name)
        # Unforwarded discoveries remain visible for manual forwarding.
        for name,candidates in self.candidates.items():
            for row in candidates:
                key=f"{name}:{row['port']}"
                if key not in desired: rows.append({**row,'key':key,'state':'Not forwarded','manual':False,'url':None})
        with self.lock: self.rows=sorted(rows,key=lambda r:(r['machine'],r['port']))

    def tick(self):
        if time.monotonic()-self.inventory_at>20:
            self.inventory();self.inventory_at=time.monotonic()
        with self.lock:
            names={self.active} | {r['machine'] for r in self.rows if r.get('state')!='Not forwarded'} | {r['machine'] for r in self.config['manual'].values()}
            names=[n for n in names if n in self.machines and self.machines[n]['state']=='connected']
            # A closed GUI must not keep discovering new services from stale PIDs.
            if time.monotonic()-self.last_sync>20: names=[]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures={pool.submit(self.scan,n):n for n in names}
            for future,name in futures.items():
                try:
                    candidates=future.result()
                    with self.lock: self.candidates[name]=candidates;self.scan_errors.pop(name,None)
                except Exception as e:
                    with self.lock: self.scan_errors[name]=str(e)
        self.reconcile()

    def close(self):
        for name in list(self.masters): self.stop_master(name)


def runtime_dir(home):
    # macOS TMPDIR is too long for OpenSSH's control socket + random suffix.
    path=Path('/tmp')/('herdr-ports-'+str(os.getuid())+'-'+hashlib.sha256(str(home.resolve()).encode()).hexdigest()[:10])
    path.mkdir(mode=0o700,exist_ok=True)
    if path.stat().st_uid!=os.getuid() or path.is_symlink(): raise RuntimeError('Unsafe Ports runtime directory')
    path.chmod(0o700);return path


def serve(home):
    runtime=runtime_dir(home)
    lock=(runtime/'lock').open('a')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: return
    path=runtime/'api.sock';path.unlink(missing_ok=True)
    manager=Manager(home,runtime)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(3)
            try: result=manager.request(json.loads(self.rfile.readline(1024*1024)))
            except Exception as e: result={'error':str(e)}
            self.wfile.write((json.dumps(result)+'\n').encode())
    server=socketserver.ThreadingUnixStreamServer(str(path),Handler);path.chmod(0o600);server.timeout=.3
    server.daemon_threads=True
    def stop(*_): manager.closed=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    def worker():
        while not manager.closed:
            try: manager.tick()
            except Exception as e:
                with manager.lock: manager.scan_errors['manager']=str(e)[-240:]
            for _ in range(25):
                if manager.closed: return
                time.sleep(.2)
    thread=threading.Thread(target=worker,daemon=True);thread.start()
    try:
        while not manager.closed: server.handle_request()
    finally: thread.join(timeout=10);manager.close();server.server_close();path.unlink(missing_ok=True)


def rpc(home, data):
    runtime=runtime_dir(home);path=runtime/'api.sock'
    for attempt in range(30):
        try:
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(3);s.connect(str(path));s.sendall((json.dumps(data)+'\n').encode())
                buf=b''
                while not buf.endswith(b'\n') and len(buf)<2*1024*1024:
                    chunk=s.recv(65536)
                    if not chunk: break
                    buf+=chunk
                return json.loads(buf)
        except (ConnectionError,FileNotFoundError):
            if attempt==0:
                folder=home/'port-forwarding';folder.mkdir(mode=0o700,parents=True,exist_ok=True)
                with (folder/'manager.log').open('a') as log:
                    subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'serve',str(home)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
            time.sleep(.05)
    raise RuntimeError('Ports helper did not start')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=['serve','rpc']);parser.add_argument('home',type=Path);parser.add_argument('payload',nargs='?',default='{}');args=parser.parse_args()
    if args.mode=='serve': serve(args.home)
    else: print(json.dumps(rpc(args.home,json.loads(args.payload))))
