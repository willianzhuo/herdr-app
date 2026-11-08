import {test,expect} from "bun:test";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {PortsController,PORTS_KEY} from "../defaults/mods/ports/controller.js";

test("detached monitors validate listener ownership, PID reuse and real local URL receipts",()=>{
  const script=new URL("./test-monitor-registration.py",import.meta.url).pathname;
  const result=spawnSync("python3",[script],{encoding:"utf8"});
  expect(result.status,result.stderr).toBe(0);
  expect(result.stdout).toContain("actual URL acknowledgement passed");
});

test("Ports batches live remote roots, preserves machine scope and shares one UI polling lease",async()=>{
  const values=new Map<string,any>(),calls:any[]=[],tasks:Promise<any>[]=[];
  const api={appHome:()=>"/tmp/herdr-ports",spaces:()=>[{active:true,machine:"814"}],
    terminals:()=>[{address:"814/t1",pid:11,state:"live"},{address:"200/t1",pid:12,state:"live"},{address:"t1",pid:13,state:"live"},{address:"814/t2",pid:14,state:"finished"}],
    settings:()=>({core:"/bin/hc"}),shared:(k:string)=>values.get(k),setShared:(k:string,v:any)=>values.set(k,v),
    exec:async(cmd:string,args:string[])=>{calls.push({cmd,args,payload:JSON.parse(args[3])});return {code:0,stdout:JSON.stringify({rows:[]})};}};
  const cx={spawn:(fn:any)=>tasks.push(fn({notify(){}}))};
  new PortsController(api).refresh(cx);new PortsController(api).refresh(cx);await Promise.all(tasks);
  expect(calls).toHaveLength(1);expect(calls[0].payload).toEqual({op:"sync",active:"814",pids:{"814":[11],"200":[12]},core:"/bin/hc"});
  expect(values.get(PORTS_KEY)).toEqual({rows:[]});
  values.delete("ports.poll");tasks.length=0;
  new PortsController({...api,exec:async()=>({code:1,stderr:"offline"})}).refresh(cx);await Promise.all(tasks);
  expect(values.get("ports.error")).toContain("offline");
  expect(values.get(PORTS_KEY)).toEqual({rows:[]});
});

test("Ports sandbox copies share the same controller",()=>{
  const source=readFileSync(new URL("../defaults/mods/ports/controller.js",import.meta.url),"utf8");
  for(const file of ["defaults/mods/tabs/ports-controller.js","personal-config/ports-controller.js"])
    expect(readFileSync(new URL(`../${file}`,import.meta.url),"utf8")).toBe(source);
});

test("Ports controls use exact machine/port addresses and only open URLs after a click",()=>{
  const code=readFileSync(new URL("../defaults/mods/ports/main.js",import.meta.url),"utf8").replace(/^import .*;\n/gm,"").replace('export default class Ports','class Ports');
  const actions:any[]=[],urls:string[]=[],copies:string[]=[];
  const element=():any=>{
    const node:any={kids:[],calls:new Map()};const proxy=new Proxy(node,{get:(n,k:any)=>k in n?n[k]:(...args:any[])=>{
      if(k==='when')return args[0]?args[1](proxy):proxy;
      if(k==='child')n.kids.push(args[0]);if(k==='children')n.kids.push(...args[0]);n.calls.set(k,args);return proxy;
    }});return proxy;
  };
  const state={machines:[{name:'814',target:'814'}],rows:[{key:'814:8000',machine:'814',port:8000,local:18000,state:'Forwarded',url:'http://127.0.0.1:18000'}]};
  const globals={View:class{},div:element,v_flex:element,h_flex:element,Input:{new:element},InputState:{new:()=>({text:'',value(){return this.text},on(){}})},
    props:()=>({}),spaces:()=>[{active:true,machine:'814'}],terminals:()=>[],settings:()=>({}),appHome:()=>'/tmp/test',exec:async()=>({}),
    shared:(key:string)=>key===PORTS_KEY?state:null,setShared:()=>{},theme:()=>({}),PORTS_KEY,
    PortsController:class{refresh(){}send(...args:any[]){actions.push(args.slice(0,2));}}};
  const Ports=new Function(...Object.keys(globals),code+';return Ports;')(...Object.values(globals));
  const view=new Ports();const cx={timer:{every(){}},notify(){},open_url:(url:string)=>urls.push(url),write_to_clipboard:(s:string)=>copies.push(s)};view.init({},cx);
  const flatten=(n:any):any[]=>n&&typeof n==='object'?[n,...(n.kids??[]).flatMap(flatten)]:[];
  const nodes=()=>flatten(view.render(cx));const click=(id:string)=>nodes().find(n=>n.calls?.get('id')?.[0]===id).calls.get('on_click')[0]({},cx);
  expect(urls).toEqual([]);view.port.text='8000';click('ports-add');click('ports-auto');click('port-action-814:8000');click('ports-stop-all');click('port-copy-814:8000');
  expect(actions).toEqual([['forward',{machine:'814',port:8000}],['auto',{machine:'814',enabled:false}],['stop',{machine:'814',port:8000}],['stop-all',{machine:'814'}]]);
  expect(copies).toEqual(['127.0.0.1:18000']);
  view.port.text='8000;id';click('ports-add');expect(actions).toHaveLength(4);
  nodes().find(n=>n.calls?.get('tooltip')?.[0]==='Open in browser').calls.get('on_click')[0]({},cx);
  expect(urls).toEqual(['http://127.0.0.1:18000']);
});

test("forwarding policy validates destinations, persists stop/auto choices and never stops remote programs",()=>{
  const root=mkdtempSync(join(tmpdir(),"herdr-ports-policy-"));
  try {
    const helper=new URL("../defaults/mods/ports/forward.py",import.meta.url).pathname;
    const code=String.raw`
import importlib.util,pathlib,socket,sys,types
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('ports',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
home=pathlib.Path(sys.argv[2]);runtime=home/'runtime';runtime.mkdir();manager=m.Manager(home,runtime)
for bad in [0,65536,True,'8000']:
    try:m.valid_port(bad);raise AssertionError(bad)
    except ValueError:pass
for bad in ['-Ffile','host -Lbad','host;touch /tmp/bad','$(id)']:
    try:m.valid_target(bad);raise AssertionError(bad)
    except ValueError:pass
assert m.valid_port(80)==80 and m.valid_target('user@dev-host')=='user@dev-host'
manager.machines={'814':{'name':'814','target':'814','state':'connected'}}
manager.candidates={'814':[{'machine':'814','port':8123,'host':'127.0.0.1','process':'python','pid':42}]}
sock=runtime/'ssh';sock.touch()
master={'socket':sock,'target':'814','process':types.SimpleNamespace(poll=lambda:None,terminate=lambda:None,wait=lambda **_:None)}
manager.master=lambda name,target:(sock.touch() or master)
ops=[]
manager.control=lambda master,op,spec=None:(ops.append((op,spec)) or types.SimpleNamespace(returncode=0,stderr=''))
manager.reconcile();assert manager.rows[0]['state']=='Forwarded'
assert ops[0][0]=='forward' and ops[0][1].startswith('127.0.0.1:')
manager.masters['814']=master
manager.request({'op':'stop','machine':'814','port':8123});manager.reconcile()
assert manager.rows[0]['state']=='Not forwarded' and any(op[0]=='cancel' for op in ops)
manager.request({'op':'forward','machine':'814','port':8123});manager.reconcile()
assert manager.rows[0]['state']=='Forwarded'
manager.request({'op':'auto','machine':'814','enabled':False});assert manager.config['manual']
assert m.Manager(home,runtime).config['auto']['814'] is False
assert (manager.config_path.stat().st_mode & 0o777)==0o600
with socket.socket() as held:
    held.bind(('127.0.0.1',0));port=held.getsockname()[1]
    assert manager.free_port(port)!=port
assert manager.spec({'local':8123,'host':'::1','port':8000})=='127.0.0.1:8123:[::1]:8000'
print('policy passed')
`;
    const r=spawnSync("python3",["-c",code,helper,root],{encoding:"utf8"});
    expect(r.status,r.stderr).toBe(0);expect(r.stdout).toContain("policy passed");
  } finally {rmSync(root,{recursive:true,force:true});}
});
