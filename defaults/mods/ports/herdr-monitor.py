#!/usr/bin/env python3
"""Register an existing monitoring service with Herdr and read actual local URLs."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


def directory():
    root=Path.home()/'.config/herdr-custom/port-forwarding'
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    return root


def start_tick(pid):
    proc=Path('/proc')/str(pid)
    if proc.stat().st_uid!=os.getuid(): raise ValueError('Service PID belongs to another user')
    return (proc/'stat').read_text().rsplit(')',1)[1].split()[19]


def request(port,pid,label,scheme='http',path='/'):
    if not 1<=port<=65535: raise ValueError('Invalid TCP port')
    if not path.startswith('/') or any(c in path for c in '\r\n') or len(path)>2048: raise ValueError('Use a URL path starting with /')
    started=start_tick(pid)
    inodes=set()
    for fd in (Path('/proc')/str(pid)/'fd').iterdir():
        try:
            target=os.readlink(fd)
            if target.startswith('socket:['): inodes.add(target[8:-1])
        except OSError: pass
    listening=False
    for table in ['tcp','tcp6']:
        try: lines=Path('/proc/net/'+table).read_text().splitlines()[1:]
        except OSError: continue
        for line in lines:
            f=line.split()
            if len(f)>9 and f[3]=='0A' and int(f[1].split(':')[1],16)==port and f[9] in inodes: listening=True
    if not listening: raise ValueError('This PID is not listening on that port; inspect the existing service first')
    root=directory();registry=root/'requests.json'
    try: data=json.loads(registry.read_text())
    except (OSError,ValueError): data={'requests':[]}
    rows=[r for r in data.get('requests',[]) if r.get('port')!=port]
    row={'id':uuid.uuid4().hex,'port':port,'pid':pid,'start':started,'label':label[:160],
         'scheme':scheme,'path':path,'requested_at':time.time()}
    rows.append(row)
    with tempfile.NamedTemporaryFile(dir=root,mode='w',delete=False) as f:
        json.dump({'requests':rows[-64:]},f,ensure_ascii=False);staged=Path(f.name)
    staged.chmod(0o600);staged.replace(registry)
    return {'request':row,'status':'waiting_for_Herdr','next':'Run links --port '+str(port)+' --wait 60'}


def links(port=None,client=None):
    result=[]
    for f in (directory()/'clients').glob('*.json'):
        try:
            # Use remote filesystem time; the Mac and development host may have
            # different clocks. Never invent localhost URLs from remote ports.
            if time.time()-f.stat().st_mtime>60: continue
            data=json.loads(f.read_text());identity=data.get('client',{})
            if client and client not in [identity.get('id'),identity.get('name')]: continue
            for row in data.get('rows',[]):
                if row.get('state')=='Forwarded' and row.get('url') and (port is None or row.get('port')==port):
                    result.append({**row,'local_client':identity.get('name'),'client_id':identity.get('id')})
        except (OSError,ValueError,TypeError): continue
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);commands=parser.add_subparsers(dest='command',required=True)
    p=commands.add_parser('request');p.add_argument('--port',type=int,required=True);p.add_argument('--pid',type=int,required=True)
    p.add_argument('--label',required=True);p.add_argument('--scheme',choices=['http','https'],default='http');p.add_argument('--path',default='/')
    p=commands.add_parser('links');p.add_argument('--port',type=int);p.add_argument('--client');p.add_argument('--wait',type=int,default=0)
    args=parser.parse_args()
    if args.command=='request': print(json.dumps(request(args.port,args.pid,args.label,args.scheme,args.path),ensure_ascii=False))
    else:
        deadline=time.monotonic()+min(120,max(0,args.wait))
        while True:
            rows=links(args.port,args.client)
            if rows or time.monotonic()>=deadline: break
            time.sleep(.5)
        print(json.dumps({'links':rows,'status':'ready' if rows else 'waiting_for_Herdr',
            'hint':None if rows else 'Select this machine in Herdr, enable Ports Auto, and check its SSH connection. A stopped port must be explicitly forwarded again.'},ensure_ascii=False))
