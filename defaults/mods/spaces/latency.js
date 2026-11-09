export const LATENCY_KEY = "machines.latency";
export const LATENCY_SETTINGS_KEY = "machines.latency.settings";
const INTERVAL = 15000;
export function latencySettings(value) {
  const warningMs = Number(value?.warningMs), timeoutMs = Number(value?.timeoutMs);
  return { enabled:value?.enabled !== false,
    warningMs:Number.isInteger(warningMs) && warningMs >= 1 && warningMs < 60000 ? warningMs : 500,
    timeoutMs:Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000 ? timeoutMs : 5000 };
}

export function validateLatencySettings(value) {
  const warningMs = Number(value.warningMs), timeoutMs = Number(value.timeoutMs);
  if (!Number.isInteger(warningMs) || warningMs < 1 || warningMs >= 60000)
    throw new Error("高延时门槛须为 1–59999 ms 的整数");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 || timeoutMs <= warningMs)
    throw new Error("超时门槛须大于高延时门槛，且为 100–60000 ms 的整数");
  return { enabled:value.enabled !== false, warningMs, timeoutMs };
}

// Uses the existing core route (including --via), not a second SSH connection.
// At most one small, bounded read-only probe per connected machine per interval.
export class MachineLatency {
  constructor(api) { this.api = api; this.busy = new Set(); this.current = new Map(); }

  refresh(rows, cx) {
    const { exec, shared, setShared } = this.api;
    const settings = latencySettings(shared(LATENCY_SETTINGS_KEY));
    if (!settings.enabled) {
      this.current.clear();
      setShared(LATENCY_KEY, {});
      return;
    }
    const timeout = settings.timeoutMs;
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
      cache[name] = { id, state:"pending", at:Date.now(), timeoutMs:timeout, lease };
      this.busy.add(name);
      probes.push(async cx => {
        const start = Date.now();
        let result;
        try {
          const reply = await exec("true", [], { on:name, timeout });
          const ms = Math.max(0, Date.now() - start);
          result = reply.code === 0 && ms < timeout ? { state:"ok", ms } : { state:ms >= timeout ? "timeout" : "error" };
        } catch {
          result = { state:Date.now() - start >= timeout ? "timeout" : "error" };
        } finally { this.busy.delete(name); }
        if (!latencySettings(shared(LATENCY_SETTINGS_KEY)).enabled || this.current.get(name) !== token || shared(LATENCY_KEY)?.[name]?.lease !== lease) return;
        setShared(LATENCY_KEY, { ...shared(LATENCY_KEY), [name]:{ id, ...result, timeoutMs:timeout, at:Date.now() } });
        cx.notify();
      });
    }
    setShared(LATENCY_KEY, cache);
    for (const probe of probes) cx.spawn(probe);
  }
}

export function latencyBadge(machine, cache, now = Date.now(), options) {
  const settings = latencySettings(options);
  if (!settings.enabled) return { label:"已关闭", state:"disabled", tooltip:"延时检测已关闭" };
  if (!machine) return { label:"本机", state:"local", tooltip:"本机终端" };
  const sample = cache?.[machine.name];
  let state = machine.state !== "connected" ? "offline" : sample?.id === machine.id ? sample.state : "pending";
  if (["ok", "error", "timeout"].includes(state) && now - sample.at > 45000) state = "stale";
  if (state === "pending" && sample?.id === machine.id && now - sample.at >= (sample.timeoutMs ?? settings.timeoutMs)) state = "timeout";
  if (state === "ok" && sample.ms >= settings.warningMs) state = "slow";
  const label = state === "ok" || state === "slow" ? `${Math.round(sample.ms)} ms`
    : ({ pending:"测量中…", timeout:"超时", offline:"离线", error:"不可用", stale:"—" }[state] ?? "—");
  const tooltip = state === "timeout" ? `Herdr 请求超过 ${sample?.timeoutMs ?? settings.timeoutMs} ms 未响应`
    : state === "offline" ? "机器连接未建立"
    : state === "error" ? "连接响应检测失败"
    : state === "stale" ? "上次测量已过期，等待刷新"
    : `${state === "slow" ? `高延时（≥ ${settings.warningMs} ms）。` : ""}Herdr 连接响应时间，含远端处理；每 15 秒刷新。点击设置`;
  return { label, state, tooltip };
}
