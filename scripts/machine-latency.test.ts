import { test, expect, spyOn } from "bun:test";
import { MachineLatency, LATENCY_KEY, LATENCY_SETTINGS_KEY, latencyBadge, validateLatencySettings } from "../defaults/mods/spaces/latency.js";

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
  expect(latencyBadge(machine,{"200":{...cache["200"],state:"timeout"}},50000).label).toBe("—");
  expect(latencyBadge(machine,{"200":{...cache["200"],state:"error"}},50000).label).toBe("—");
  expect(latencyBadge(null,cache,200).label).toBe("本机");
});

test("a newly listed machine renders and starts its first probe before identity metadata arrives", async () => {
  const row={name:"cloud",state:"connected"};
  expect(latencyBadge(row,{}).state).toBe("pending");
  expect(latencyBadge(row,undefined).label).toBe("测量中…");
  const calls:any[]=[];
  const h=harness(async (_cmd:any,_args:any,options:any)=>{calls.push(options);return {code:0};});
  new MachineLatency(h.api).refresh([row],h.cx);await Promise.all(h.tasks);
  expect(calls).toEqual([{on:"cloud",timeout:5000}]);
  expect(latencyBadge(row,h.store.get(LATENCY_KEY)).label).toMatch(/^\d+ ms$/);
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

test("disabling stops new probes and discards a probe already in flight", async () => {
  let finish:any,calls=0;
  const h=harness(() => {calls++;return new Promise(resolve => finish=resolve);});
  const probe=new MachineLatency(h.api);probe.refresh([machine],h.cx);
  h.store.set(LATENCY_SETTINGS_KEY,{enabled:false});probe.refresh([machine],h.cx);
  finish({code:0});await Promise.all(h.tasks);probe.refresh([machine],h.cx);
  expect(calls).toBe(1);expect(h.store.get(LATENCY_KEY)).toEqual({});
  expect(latencyBadge(machine,{},Date.now(),{enabled:false}).state).toBe("disabled");
});

test("custom warning and timeout thresholds are independent, validated and used by probes", async () => {
  const options=validateLatencySettings({enabled:true,warningMs:"200",timeoutMs:"2000"});
  const cache={"200":{id:"core-a",state:"ok",ms:300,at:100}};
  expect(latencyBadge(machine,cache,200,options)).toMatchObject({label:"300 ms",state:"slow"});
  expect(latencyBadge(machine,cache,200,{...options,warningMs:400}).state).toBe("ok");
  const calls:any[]=[];const h=harness(async (_c:any,_a:any,o:any) => {calls.push(o);return {code:0};});
  h.store.set(LATENCY_SETTINGS_KEY,options);new MachineLatency(h.api).refresh([machine],h.cx);await Promise.all(h.tasks);
  expect(calls).toEqual([{on:"200",timeout:2000}]);
  expect(latencyBadge(machine,{"200":{id:"core-a",state:"pending",at:100,timeoutMs:2000}},2099,options).state).toBe("pending");
  expect(latencyBadge(machine,{"200":{id:"core-a",state:"pending",at:100,timeoutMs:2000}},2100,options).state).toBe("timeout");
  for (const patch of [{warningMs:"abc"},{warningMs:0},{timeoutMs:100},{timeoutMs:60001},{warningMs:1.5}])
    expect(() => validateLatencySettings({...options,...patch})).toThrow();
});
