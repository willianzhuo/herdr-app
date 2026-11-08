// UI and tab bar share one short-lived polling lease; SSH lives in our helper.
export const PORTS_KEY = "ports.state";

export class PortsController {
  constructor(api) { this.api=api; this.busy=false; }

  async call(payload) {
    const {exec,appHome}=this.api;
    const r=await exec("python3",[`${appHome()}/mods/ports/forward.py`,"rpc",appHome(),JSON.stringify(payload)],{timeout:8000});
    if(r.code!==0) throw Error(r.stderr || "Ports helper unavailable");
    const state=JSON.parse(r.stdout);
    if(state.error) throw Error(state.error);
    this.api.setShared(PORTS_KEY,state);this.api.setShared("ports.error",null);
    return state;
  }

  refresh(cx) {
    if(this.busy || !cx?.spawn) return;
    const {spaces,terminals,shared,setShared,settings}=this.api;
    const active=spaces().find(s=>s.active)?.machine ?? null;
    const pids={};
    for(const t of terminals()) {
      if(t.state!=="live" || !t.address?.includes("/") || !Number.isInteger(t.pid)) continue;
      const machine=t.address.split("/")[0];(pids[machine]??=[]).push(t.pid);
    }
    const key=JSON.stringify([active,pids]),lease=shared("ports.poll");
    if(lease?.key===key && Date.now()-lease.at<5000) return;
    setShared("ports.poll",{key,at:Date.now()});this.busy=true;
    cx.spawn(async cx=>{
      try { await this.call({op:"sync",active,pids,core:settings()?.core || "hc"}); }
      catch(e) { setShared("ports.error",String(e)); }
      finally { this.busy=false;cx.notify(); }
    });
  }

  send(op,args,cx) {
    cx.spawn(async cx=>{
      try { await this.call({op,...args});this.api.setShared("ports.poll",null); }
      catch(e) { this.api.setShared("ports.error",String(e)); }
      finally { cx.notify(); }
    });
  }
}
