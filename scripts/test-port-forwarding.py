#!/usr/bin/env python3
"""Opt-in SSH integration test. Creates only its own HTTP fixture and tunnels."""
import subprocess,json,shlex,socket,tempfile,pathlib,time,urllib.request,importlib.util,os,signal,argparse,sys,shutil,select
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--machine',required=True);parser.add_argument('--ssh-target');parser.add_argument('--core',default=shutil.which('hc'));args=parser.parse_args()
assert args.core,'hc must be installed'
source=pathlib.Path(__file__).resolve().parents[1]/'defaults/mods/ports/forward.py'
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('ports',source);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
token=os.urandom(12).hex()
root=pathlib.Path(tempfile.mkdtemp(prefix='herdr-forward-integration-')); print('HOME',root,flush=True)
code='''import http.server,json,os,threading
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b"herdr-forward-fixture")
  if self.path=="/shutdown":threading.Thread(target=self.server.shutdown).start()
 def log_message(self,*args):pass
server=http.server.HTTPServer(("127.0.0.1",0),Handler)
print(json.dumps({"port":server.server_port,"pid":os.getpid()}),flush=True)
server.serve_forever()
'''
code=code.replace('/shutdown','/__herdr_shutdown_'+token)
target=p.valid_target(args.ssh_target or args.machine)
fixture=subprocess.Popen(['ssh','-S','none','-o','BatchMode=yes','-o','ConnectTimeout=5',target,'python3 -u -c '+shlex.quote(code)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
held=None;remote=None
try:
 if not select.select([fixture.stdout],[],[],20)[0]:raise RuntimeError('SSH fixture did not start within 20 seconds')
 remote=json.loads(fixture.stdout.readline());port=remote['port'];print('REMOTE',remote,flush=True)
 try:
  held=socket.socket();held.bind(('127.0.0.1',port));held.listen()
 except OSError:
  if held:held.close();held=None
 def call(data):return p.rpc(root,data)
 call({'op':'target','machine':args.machine,'target':target})
 call({'op':'sync','active':args.machine,'pids':{args.machine:[remote['pid']]},'core':args.core})
 def wait_forward(timeout=45):
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   state=call({'op':'sync','active':args.machine,'pids':{args.machine:[remote['pid']]},'core':args.core})
   rows=[r for r in state['rows'] if r['machine']==args.machine and r['port']==port]
   if rows and rows[0]['state']=='Forwarded':return rows[0]
   time.sleep(.3)
  raise RuntimeError(json.dumps(state))
 row=wait_forward();assert row['local']!=port,row
 assert urllib.request.urlopen(row['url'],timeout=5).read()==b'herdr-forward-fixture'
 print('FORWARDED_WITH_COLLISION',row,flush=True); original_local=row['local']
 # Fault only this test helper's SSH master, identified by its private socket path.
 runtime=p.runtime_dir(root);ps=subprocess.check_output(['ps','-axo','pid=,command='],text=True)
 found=[int(line.strip().split(None,1)[0]) for line in ps.splitlines() if 'ssh -M -S '+str(runtime)+'/ssh-' in line]
 assert len(found)==1,found;os.kill(found[0],signal.SIGTERM)
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  time.sleep(.3)
  try:
   row=wait_forward(1)
   if urllib.request.urlopen(row['url'],timeout=1).read()==b'herdr-forward-fixture':break
  except Exception:continue
 else:raise RuntimeError('Reconnect failed')
 assert row['local']==original_local,(row['local'],original_local)
 print('RECONNECTED_STABLE_PORT',row['local'],flush=True)
 call({'op':'stop','machine':args.machine,'port':port})
 deadline=time.monotonic()+15
 while time.monotonic()<deadline:
  s=call({'op':'status'});rows=[r for r in s['rows'] if r['port']==port and r['machine']==args.machine]
  if rows and rows[0]['state']=='Not forwarded':break
  time.sleep(.3)
 else:raise RuntimeError('Stop failed')
 r=subprocess.run([args.core,'exec','--on',args.machine,'python3','-c','import urllib.request,sys;print(urllib.request.urlopen(sys.argv[1]).read().decode())','http://127.0.0.1:'+str(port)],capture_output=True,text=True,timeout=10)
 assert r.returncode==0 and 'herdr-forward-fixture' in r.stdout,r.stderr
 print('STOPPED_WITH_REMOTE_SERVICE_PRESERVED',flush=True)
finally:
 if remote and fixture.poll() is None:
  subprocess.run([args.core,'exec','--on',args.machine,'python3','-c','import urllib.request,sys;urllib.request.urlopen(sys.argv[1]).read()','http://127.0.0.1:'+str(remote['port'])+'/__herdr_shutdown_'+token],capture_output=True,timeout=10)
 try:p.rpc(root,{'op':'shutdown'})
 except Exception:pass
 if held:held.close()
 try:fixture.wait(timeout=5)
 except subprocess.TimeoutExpired:fixture.terminate();fixture.wait(timeout=3)
 print('CLEANED',root,flush=True)
