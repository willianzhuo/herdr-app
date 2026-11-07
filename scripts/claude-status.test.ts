import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE_KEY, CLAUDE_PROBE, ClaudeStatus, claudeSession, claudeStatus, claudeAgents, claudeTabStatus } from "../defaults/mods/agents/claude-status.js";

const terminal = (address="814/t1", title="◑ Session one", pid=11): any => ({
  address, title, state:"live", status:null, program:{key:"claude"}, foreground:{pid}, created_ms:123,
});
const entry = (t:any, status="working"): any => ({
  pid:t.foreground.pid, created:t.created_ms, title:t.title, session:"session-one", name:"Session one", status, at:Date.now(),
});

test("Claude fallback follows the exact machine, terminal lifetime, foreground and title; native status wins", () => {
  const t=terminal(), cache={[t.address]:entry(t)};
  expect(claudeSession(t,cache)?.status).toBe("working");
  for(const changed of [
    {...t,address:"200/t1"}, {...t,created_ms:124}, {...t,foreground:{pid:12}}, {...t,title:"Session two"},
    {...t,title:"claude agents"}, {...t,state:"finished"}, {...t,program:{key:"shell"}}, {...t,status:"idle"},
  ]) expect(claudeSession(changed,cache)).toBeNull();
  expect(claudeSession(t,{[t.address]:{...entry(t),at:Date.now()-12001}})).toBeNull();
  expect(claudeStatus(t,"blocked",cache)).toBe("blocked");
  expect(claudeStatus(t,"unknown",cache)).toBe("working");
  expect(claudeStatus({...t,status:"working"},null,cache)).toBeNull();
});

test("sidebar and tab rollup consume fallback state while preserving focus and other agents' urgency", () => {
  const t=terminal(), cache={[t.address]:entry(t,"done")};
  expect(claudeAgents([{address:t.address,status:"unknown",focused:false}],[t],cache)[0].status).toBe("done");
  expect(claudeAgents([{address:t.address,status:"unknown",focused:true}],[t],cache)[0].status).toBe("idle");
  const native={address:t.address,status:"blocked"};
  expect(claudeAgents([native],[t],cache)[0]).toBe(native);
  const panels=[{tab:"tab",terminal:t.address,status:null},{tab:"other",terminal:t.address,status:"blocked"}];
  expect(claudeTabStatus({id:"tab",status:"working"},panels,new Map([[t.address,t]]),cache)).toBe("done");
  expect(claudeTabStatus({id:"tab",status:"blocked"},panels,new Map([[t.address,t]]),cache)).toBe("blocked");
});

test("polling is batched by machine and results cannot follow a session switch; failures clear old guesses", async () => {
  let all=[terminal(),terminal("814/t2","Session two",12),terminal("200/t1","Session one",13)];
  const values=new Map<string,any>(), calls:any[]=[], tasks:Promise<any>[]=[];
  const api={ terminals:()=>all, shared:(k:string)=>values.get(k), setShared:(k:string,v:any)=>values.set(k,v),
    exec:async(_cmd:string,args:string[],options:any)=>{
      const items=JSON.parse(args[2]);calls.push({items,on:options.on});
      return {code:0,stdout:JSON.stringify(Object.fromEntries(items.map((i:any)=>[i.address,{...i,session:"session",status:"working"}])))};
    },
  };
  const cx={spawn:(fn:any)=>tasks.push(fn({notify(){}}))};
  new ClaudeStatus(api).refresh(cx);new ClaudeStatus(api).refresh(cx);await Promise.all(tasks);
  expect(calls.map(c=>c.on)).toEqual(["814","200"]);expect(calls[0].items).toHaveLength(2);
  expect(claudeSession(all[0],values.get(CLAUDE_KEY))?.status).toBe("working");
  values.delete("claude.status-probe");tasks.length=0;
  new ClaudeStatus({...api,exec:async(...args:any[])=>{
    const result=await (api.exec as any)(...args);all=all.map(t=>t.address==="814/t1"?{...t,title:"Session switched"}:t);return result;
  }}).refresh(cx);await Promise.all(tasks);
  expect(claudeSession(all[0],values.get(CLAUDE_KEY))).toBeNull();
  values.delete("claude.status-probe");tasks.length=0;
  new ClaudeStatus({...api,exec:async()=>{throw Error("offline");}}).refresh(cx);await Promise.all(tasks);
  expect(values.get(CLAUDE_KEY)).toEqual({});
});

test("production probe reads official background status in each process profile and rejects duplicate or stale identities", () => {
  const root=mkdtempSync(join(tmpdir(),"herdr-claude-probe-"));
  try {
    const proc=join(root,"proc");mkdirSync(proc);
    const cli=join(root,"fake-claude");
    writeFileSync(cli,`#!/usr/bin/python3
import json,os,sys
assert sys.argv[1:] == ['agents','--json','--all']
assert os.environ['CLAUDE_CONFIG_DIR'].endswith(os.environ['PROFILE'])
if os.environ.get('REPLACE_STAT'):
    p=os.environ['REPLACE_STAT']
    s=open(p).read();open(p,'w').write(s.replace(' 999 ', ' 1000 '))
print(open(os.environ['FIXTURE']).read())
`);chmodSync(cli,0o755);
    const rows=(state:string)=>[{kind:"background",name:"Session one",sessionId:"uuid",id:"job",state,status:"idle"}];
    const fixtures=[join(root,"profile-a.json"),join(root,"profile-b.json")];
    writeFileSync(fixtures[0],JSON.stringify(rows("working")));writeFileSync(fixtures[1],JSON.stringify(rows("blocked")));
    for(const [i,pid] of [11,12].entries()) {
      const p=join(proc,String(pid));mkdirSync(p);
      symlinkSync(cli,join(p,"exe"));writeFileSync(join(p,"cmdline"),"claude\0--dangerously-skip-permissions\0");
      writeFileSync(join(p,"stat"),`${pid} (Claude with spaces) S ${Array(18).fill("0").join(" ")} 999 0`);
      writeFileSync(join(p,"environ"),`HOME=${root}\0CLAUDE_CONFIG_DIR=${root}/profile-${i}\0PROFILE=profile-${i}\0FIXTURE=${fixtures[i]}\0`);
    }
    const items=[{address:"814/t1",pid:11,created:123,title:"◑ Session one"},{address:"814/t2",pid:12,created:123,title:"✻ Session one"}];
    const probe=CLAUDE_PROBE.replace('PROC_ROOT = Path("/proc")',`PROC_ROOT = Path(${JSON.stringify(proc)})`);
    const run=()=>{
      const r=spawnSync("python3",["-c",probe,JSON.stringify(items)],{encoding:"utf8"});expect(r.status).toBe(0);return JSON.parse(r.stdout);
    };
    expect(run()["814/t1"].status).toBe("working"); // Coarse state wins over idle between steps.
    expect(run()["814/t2"].status).toBe("blocked"); // Same title/cwd, separate profiles.
    writeFileSync(fixtures[0],JSON.stringify([...rows("done"),{...rows("blocked")[0],sessionId:"other"}]));
    expect(run()["814/t1"]).toBeUndefined(); // Ambiguous names must stay unknown.
    writeFileSync(fixtures[0],JSON.stringify(rows("done")));expect(run()["814/t1"].status).toBe("done");
    items[0].title="claude agents";expect(run()["814/t1"]).toBeUndefined();
    items[0].title="Session one";
    writeFileSync(join(proc,"11/environ"),readFileSync(join(proc,"11/environ"),"utf8")+`REPLACE_STAT=${join(proc,"11/stat")}\0`);
    expect(run()["814/t1"]).toBeUndefined();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("sandboxed views and the personal tab example share the same Claude adapter", () => {
  const canonical=readFileSync(new URL("../defaults/mods/agents/claude-status.js",import.meta.url),"utf8");
  for(const path of ["defaults/mods/tabs/claude-status.js","defaults/mods/pane/claude-status.js","defaults/mods/terminals-pane/claude-status.js","personal-config/claude-status.js"])
    expect(readFileSync(new URL(`../${path}`,import.meta.url),"utf8")).toBe(canonical);
});
