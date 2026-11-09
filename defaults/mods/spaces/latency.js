export const LATENCY_KEY = "machines.latency";
const INTERVAL = 15000;
const TIMEOUT = 5000;

// Uses the existing core route (including --via), not a second SSH connection.
// At most one small, bounded read-only probe per connected machine per interval.
export class MachineLatency {
  constructor(api) { this.api = api; this.busy = new Set(); this.current = new Map(); }

  refresh(rows, cx) {
    const { exec, shared, setShared } = this.api;
    this.current = new Map(rows.map(m => [m.name, `${m.id}:${m.state}`]));
    const cache = { ...shared(LATENCY_KEY) };
    const probes = [];
    for (const name of Object.keys(cache)) if (!this.current.has(name)) delete cache[name];
    for (const machine of rows) {
      const { name, id } = machine;
      if (machine.state !== "connected") {
        cache[name] = { id, state:"offline", at:Date.now() };
        continue;
      }
      const previous = cache[name];
      if (this.busy.has(name) || (previous?.id === id && previous.state !== "offline" && Date.now() - previous.at < INTERVAL)) continue;
      const token = this.current.get(name);
      const lease = `${Date.now()}:${Math.random()}`;
      // This shared lease also deduplicates multiple sidebar instances/reloads.
      cache[name] = { id, state:"pending", at:Date.now(), lease };
      this.busy.add(name);
      probes.push(async cx => {
        const start = Date.now();
        let result;
        try {
          const reply = await exec("true", [], { on:name, timeout:TIMEOUT });
          const ms = Math.max(0, Date.now() - start);
          result = reply.code === 0 && ms < TIMEOUT ? { state:"ok", ms } : { state:ms >= TIMEOUT ? "timeout" : "error" };
        } catch {
          result = { state:Date.now() - start >= TIMEOUT ? "timeout" : "error" };
        } finally { this.busy.delete(name); }
        if (this.current.get(name) !== token || shared(LATENCY_KEY)?.[name]?.lease !== lease) return;
        setShared(LATENCY_KEY, { ...shared(LATENCY_KEY), [name]:{ id, ...result, at:Date.now() } });
        cx.notify();
      });
    }
    setShared(LATENCY_KEY, cache);
    for (const probe of probes) cx.spawn(probe);
  }
}

export function latencyBadge(machine, cache, now = Date.now()) {
  if (!machine) return { label:"本机", state:"local", tooltip:"本机终端" };
  const sample = cache?.[machine.name];
  let state = machine.state !== "connected" ? "offline" : sample?.id === machine.id ? sample.state : "pending";
  if (state === "ok" && now - sample.at > 45000) state = "stale";
  const label = state === "ok" ? `${Math.round(sample.ms)} ms`
    : ({ pending:"测量中…", timeout:"超时", offline:"离线", error:"不可用", stale:"—" }[state] ?? "—");
  const tooltip = state === "timeout" ? "Herdr 请求超过 5000 ms 未响应"
    : state === "offline" ? "机器连接未建立"
    : state === "error" ? "连接响应检测失败"
    : state === "stale" ? "上次测量已过期，等待刷新"
    : "Herdr 连接响应时间，含远端处理；每 15 秒刷新，非 ICMP ping";
  return { label, state, tooltip };
}
