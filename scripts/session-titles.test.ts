import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROBE, SESSION_KEY, SessionTitles, sessionTitle } from "../defaults/mods/agents/session-titles.js";

const program = { key:"traex" };
const terminal = (address:string, pid:number) => ({ address, state:"live", program, foreground:{ pid }, created_ms:123 });

test("session cache is tied to machine, live foreground PID, terminal identity and freshness", () => {
  const a = terminal("200/t1", 11), b = terminal("814/t1", 12);
  const cache = { [a.address]:{ pid:11, created:123, name:"Own session", at:Date.now() } };
  expect(sessionTitle(a, cache)).toBe("Own session");
  expect(sessionTitle(b, cache)).toBeNull();
  for (const t of [{...a, state:"finished"}, {...a, created_ms:124}, {...a, foreground:{pid:13}}, {...a, program:{key:"shell"}}])
    expect(sessionTitle(t, cache)).toBeNull();
  expect(sessionTitle(a, {[a.address]:{...cache[a.address], at:Date.now()-21000}})).toBeNull();
});

test("resolver batches per machine, deduplicates refreshes and discards a result after the process changes", async () => {
  let all = [terminal("200/t1",11), terminal("200/t2",12), terminal("814/t1",13)];
  const values = new Map<string,any>();
  const calls:any[] = [], tasks:Promise<any>[] = [];
  const api = {
    terminals:() => all, shared:(key:string) => values.get(key), setShared:(key:string,value:any) => values.set(key,value),
    exec:async (_cmd:string,args:string[],options:any) => {
      const items=JSON.parse(args[2]); calls.push({items,on:options.on});
      return {code:0,stdout:JSON.stringify(Object.fromEntries(items.map((i:any)=>[i.address,{...i,session:"id",name:i.address}])))};
    },
  };
  const cx={ spawn:(fn:any) => tasks.push(fn({notify(){}})) };
  new SessionTitles(api).refresh(cx); new SessionTitles(api).refresh(cx);
  await Promise.all(tasks);
  expect(calls.map(c=>c.on)).toEqual(["200","814"]);
  expect(calls[0].items).toHaveLength(2);
  expect(sessionTitle(all[2],values.get(SESSION_KEY))).toBe("814/t1");
  values.delete("traex.session-probe"); tasks.length=0;
  const pending = new SessionTitles({...api, exec:async (...args:any[]) => {
    const result=await (api.exec as any)(...args);
    all=all.map(t=>t.address==="200/t1"?{...t,foreground:{pid:99}}:t);
    return result;
  }});
  pending.refresh(cx); await Promise.all(tasks);
  expect(sessionTitle(all[0],values.get(SESSION_KEY))).toBeNull();
});

test("production Python probe distinguishes same-directory panels and follows open session files, including rename and ambiguous transitions", () => {
  const root=mkdtempSync(join(tmpdir(),"herdr-session-probe-"));
  try {
    const proc=join(root,"proc"), cli=join(root,"cli"), sessions=join(cli,"sessions");
    mkdirSync(sessions,{recursive:true});
    const ids=["11111111-1111-7111-8111-111111111111","22222222-2222-7222-8222-222222222222"];
    const paths=ids.map(id=>join(sessions,`rollout-2026-11-06T11-40-15-${id}_33333333-3333-7333-8333-333333333333.jsonl`));
    for (const path of paths) writeFileSync(path,"");
    for (const [i,pid] of [11,12].entries()) {
      const p=join(proc,String(pid)); mkdirSync(join(p,"fd"),{recursive:true});
      symlinkSync(join(root,"traex"),join(p,"exe"));
      symlinkSync(paths[i],join(p,"fd","1"));
      symlinkSync(paths[i]+".lock",join(p,"fd","2"));
    }
    const setup=spawnSync("python3",["-c",`import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('create table threads(id text primary key,name text,title text)'); db.executemany('insert into threads values(?,?,?)',[(sys.argv[2],'Session one','Old prompt'),(sys.argv[3],'Session two','Other prompt')]); db.commit()`,join(cli,"state_5.sqlite"),...ids]);
    expect(setup.status).toBe(0);
    const args=[{address:"200/t1",pid:11,created:123},{address:"200/t2",pid:12,created:123}];
    const probe=PROBE.replace('PROC_ROOT = Path("/proc")',`PROC_ROOT = Path(${JSON.stringify(proc)})`);
    const run=()=>{ const p=spawnSync("python3",["-c",probe,JSON.stringify(args)],{encoding:"utf8"}); expect(p.status).toBe(0);return JSON.parse(p.stdout); };
    expect(run()["200/t1"].name).toBe("Session one");
    expect(run()["200/t2"].name).toBe("Session two");
    symlinkSync(paths[1],join(proc,"11/fd/3"));
    expect(run()["200/t1"]).toBeUndefined(); // Don't guess during a transition.
    unlinkSync(join(proc,"11/fd/1"));unlinkSync(join(proc,"11/fd/2"));
    expect(run()["200/t1"].name).toBe("Session two"); // Launch argv need not change.
    spawnSync("python3",["-c","import sqlite3,sys; db=sqlite3.connect(sys.argv[1]);db.execute('update threads set name=? where id=?',('Renamed session',sys.argv[2]));db.commit()",join(cli,"state_5.sqlite"),ids[1]]);
    expect(run()["200/t1"].name).toBe("Renamed session");
    unlinkSync(join(proc,"11/fd/3"));
    mkdirSync(join(cli,"thread-writer-locks"));
    const lock=join(cli,"thread-writer-locks",ids[1]+".lock");writeFileSync(lock,"");
    symlinkSync(lock,join(proc,"11/fd/4"));
    expect(run()["200/t1"].name).toBe("Renamed session"); // Older CLI: writer lock only.
  } finally { rmSync(root,{recursive:true,force:true}); }
});


test("sandboxed mods and the personal tab example ship the same resolver", () => {
  const canonical=readFileSync(new URL("../defaults/mods/agents/session-titles.js",import.meta.url),"utf8");
  for (const path of ["defaults/mods/tabs/session-titles.js","defaults/mods/pane/session-titles.js","defaults/mods/terminals-pane/session-titles.js","personal-config/session-titles.js"])
    expect(readFileSync(new URL(`../${path}`,import.meta.url),"utf8")).toBe(canonical);
});
