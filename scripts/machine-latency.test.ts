import { test, expect, spyOn } from "bun:test";
import { MachineLatency, LATENCY_KEY, latencyBadge } from "../defaults/mods/spaces/latency.js";

const machine = { name:"200", id:"core-a", state:"connected" };
function harness(exec:any) {
  const store = new Map<string, any>(), tasks:Promise<any>[] = [];
  const api = { exec, shared:(k:string) => store.get(k), setShared:(k:string, v:any) => store.set(k,v) };
  const cx = { spawn:(fn:any) => tasks.push(fn({ notify() {} })) };
  return { api, cx, store, tasks };
}

test("latency is an integer ms response time, with explicit stale/offline/timeout states", () => {
  const cache = { "200":{ id:"core-a", state:"ok", ms:42.6, at:100 } };
  expect(latencyBadge(machine,cache,200).label).toBe("43 ms");
  expect(latencyBadge(machine,cache,50000).label).toBe("—");
  expect(latencyBadge({...machine,state:"asleep"},cache,200).label).toBe("离线");
  expect(latencyBadge({...machine,id:"replacement"},cache,200).label).toBe("测量中…");
  expect(latencyBadge(machine,{"200":{...cache["200"],state:"timeout"}},200).label).toBe("超时");
  expect(latencyBadge(null,cache,200).label).toBe("本机");
});

test("one bounded probe per machine, shared across sidebars; slow peers do not block others", async () => {
  let finish:any;
  const calls:any[] = [];
  const h = harness((_cmd:string,_args:any,options:any) => {
    calls.push({command:_cmd,args:_args,...options});
    return options.on === "200" ? new Promise(resolve => finish=resolve) : Promise.resolve({code:0});
  });
  const rows = [machine,{...machine,name:"814",id:"core-b"},{...machine,name:"offline",state:"asleep"}];
  const probe = new MachineLatency(h.api);
  probe.refresh(rows,h.cx);probe.refresh(rows,h.cx);new MachineLatency(h.api).refresh(rows,h.cx);
  await Promise.resolve();
  expect(calls).toEqual([
    {command:"true",args:[],on:"200",timeout:5000},
    {command:"true",args:[],on:"814",timeout:5000},
  ]);
  expect(h.store.get(LATENCY_KEY)["814"].state).toBe("ok");
  finish({code:0});await Promise.all(h.tasks);
  expect(h.store.get(LATENCY_KEY)["200"].state).toBe("ok");
});

test("a completed stale probe cannot overwrite a replacement core or disconnected state", async () => {
  let finish:any;
  const h = harness(() => new Promise(resolve => finish=resolve));
  const probe = new MachineLatency(h.api);
  probe.refresh([machine],h.cx);
  probe.refresh([{...machine,id:"replacement",state:"asleep"}],h.cx);
  finish({code:0});await Promise.all(h.tasks);
  expect(h.store.get(LATENCY_KEY)["200"]).toMatchObject({id:"replacement",state:"offline"});
});

test("timed out requests never turn into a successful old numeric reading", async () => {
  const clock = spyOn(Date,"now").mockReturnValue(1000);
  try {
    const h = harness(async () => { clock.mockReturnValue(6001);throw new Error("deadline"); });
    new MachineLatency(h.api).refresh([machine],h.cx);await Promise.all(h.tasks);
    expect(latencyBadge(machine,h.store.get(LATENCY_KEY)).label).toBe("超时");
  } finally { clock.mockRestore(); }
});
