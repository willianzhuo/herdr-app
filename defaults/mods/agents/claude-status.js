// Read-only Claude session status. Background views match exact titles; a
// shell-only native working report needs PID-bound proof of a finished turn.
export const CLAUDE_KEY = "claude.session-status";
export const CLAUDE_PROBE = String.raw`import json, os, re, subprocess, sys
from pathlib import Path

PROC_ROOT = Path("/proc")

def title(value):
    value = str(value or "").strip()
    return value[next((i for i, c in enumerate(value) if c.isalnum()), len(value)):].strip()

def identity(pid):
    proc = PROC_ROOT / str(pid)
    # comm may contain spaces: fields after its final ')' start with state.
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    return fields[19]

def process(item):
    pid = item.get("pid")
    if not isinstance(pid, int) or pid <= 0 or not title(item.get("title")):
        return None
    proc = PROC_ROOT / str(pid)
    start = identity(pid)
    args = (proc / "cmdline").read_bytes().split(b"\0")
    if not args or Path(os.fsdecode(args[0])).name != "claude":
        return None
    env = dict(s.split("=", 1) for s in (proc / "environ").read_text().split("\0") if "=" in s)
    home = env.get("HOME")
    if not home:
        return None
    config = env.get("CLAUDE_CONFIG_DIR", str(Path(home) / ".claude"))
    return proc, start, env, (str((proc / "exe").resolve()), home, config)

def select(rows, item):
    own = title(item.get("title"))
    if re.fullmatch(r"(?:\d+ awaiting input · )?claude agents", own):
        # This is a profile-wide dashboard, not one workspace's session.
        counts = {s:0 for s in ("working", "blocked", "done", "failed", "stopped")}
        for row in rows:
            if isinstance(row, dict) and row.get("kind") == "background" and row.get("state") in counts:
                counts[row["state"]] += 1
        state = "blocked" if counts["blocked"] else "working" if counts["working"] else "idle"
        name = "Claude Dashboard"
        if counts["blocked"]:
            name += " · " + str(counts["blocked"]) + " need input"
        elif counts["working"]:
            name += " · " + str(counts["working"]) + " working"
        return {"session":"dashboard", "scope":"dashboard", "name":name,
                "status":state, "counts":counts,
                "detail":"All background sessions in this Claude profile: " + ", ".join(str(n) + " " + s for s,n in counts.items())}
    matches = [r for r in rows if isinstance(r, dict) and r.get("kind") == "background"
               and r.get("sessionId") and title(r.get("name")) == own]
    if len(matches) != 1:
        return None
    row = matches[0]
    state = {"working":"working", "blocked":"blocked", "done":"done", "failed":"blocked", "stopped":"blocked"}.get(row.get("state"))
    if not state:
        return None
    return {"session":row["sessionId"], "job":row.get("id"), "name":str(row["name"])[:240],
            "status":state, "waitingFor":str(row.get("waitingFor") or "")[:160]}

def completed_turn(config, row):
    session = row.get("sessionId")
    if not isinstance(session, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", session):
        return None
    base = Path(config) / "projects"
    path = base / re.sub(r"[^A-Za-z0-9]", "-", str(row.get("cwd") or "")) / (session + ".jsonl")
    if not path.is_file():
        # Exact session id only; shared cwd or a similar name is never proof.
        from itertools import islice
        paths = list(islice(base.glob("*/" + session + ".jsonl"), 2))
        if len(paths) != 1:
            return None
        path = paths[0]
    def signature(s): return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    with path.open("rb") as f:
        before = os.fstat(f.fileno())
        offset = max(0, before.st_size - 524288)
        f.seek(offset)
        if offset: f.readline(524288)  # Discard the first partial JSON line.
        data = f.read(524288)
        after = os.fstat(f.fileno())
    if signature(before) != signature(after) or signature(after) != signature(path.stat()) or not data.endswith(b"\n"):
        return None
    assistant, done = None, None
    for line in data.splitlines():
        event = json.loads(line)
        if not isinstance(event, dict): return None
        if event.get("isSidechain"): continue
        kind = event.get("type")
        if kind in ("user", "assistant", "api-request", "queue-operation") and event.get("sessionId") != session:
            return None
        if event.get("sessionId") != session: continue
        if kind in ("user", "queue-operation") or (kind == "api-request" and event.get("querySource") != "away_summary"):
            assistant, done = None, None
        elif kind == "assistant":
            assistant, done = event, None
        elif kind == "system" and event.get("subtype") == "turn_duration":
            done = None
            message = (assistant or {}).get("message") or {}
            if (assistant and assistant.get("uuid") and event.get("parentUuid") == assistant["uuid"]
                and message.get("stop_reason") == "end_turn"
                and any(isinstance(c, dict) and c.get("type") == "text" and c.get("text") for c in message.get("content", []))):
                done = {"completedTurn":event.get("uuid"), "completedAt":event.get("timestamp")}
    return done

def interactive_done(rows, item, config):
    match = re.fullmatch(r"([1-9][0-9]*) shells? still running", str(item.get("nativeMessage") or ""))
    if item.get("nativeStatus") != "working" or not match: return None
    matches = [r for r in rows if isinstance(r, dict) and r.get("kind") == "interactive" and r.get("pid") == item["pid"]]
    if len(matches) != 1: return None
    row = matches[0]
    # Registry PID reuse must not bind an old session to a new Claude process.
    boot = next(int(line.split()[1]) for line in (PROC_ROOT / "stat").read_text().splitlines() if line.startswith("btime "))
    started = (boot + int(identity(item["pid"])) / os.sysconf("SC_CLK_TCK")) * 1000
    if not isinstance(row.get("startedAt"), (int, float)) or not 0 <= row["startedAt"] - started < 120000:
        return None
    proof = completed_turn(config, row)
    if not proof or not proof.get("completedTurn"): return None
    count = int(match[1])
    return dict(proof, session=row["sessionId"], scope="interactive", status="done", backgroundShells=count,
                name=title(item["title"]), nativeKey=item.get("nativeKey"),
                detail="当前回答已完成；后台仍有 " + str(count) + " 个 shell 运行（未停止）")

def probe(items):
    result, profiles = {}, {}
    if not PROC_ROOT.is_dir():
        return result
    for item in items[:64]:
        try:
            found = process(item)
            if found:
                proc, start, env, profile = found
                profiles.setdefault(profile, []).append((item, proc, start, env))
        except (OSError, ValueError, IndexError):
            pass
    for group in profiles.values():
        first, proc, _, env = group[0]
        try:
            # Use the foreground process's binary and profile, not PATH or this
            # machine's default Claude account. No hooks, prompts or task writes.
            reply = subprocess.run([str(proc / "exe"), "agents", "--json", "--all"],
                env=env, cwd=env["HOME"], capture_output=True, text=True, timeout=4)
            rows = json.loads(reply.stdout) if reply.returncode == 0 else None
            if not isinstance(rows, list):
                continue
            for item, proc, start, _ in group:
                try:
                    config = env.get("CLAUDE_CONFIG_DIR", str(Path(env["HOME"]) / ".claude"))
                    entry = interactive_done(rows, item, config) if item.get("nativeStatus") else select(rows, item)
                    if entry and identity(item["pid"]) == start:
                        result[item["address"]] = dict(entry, pid=item["pid"], created=item.get("created"), title=item["title"])
                except (OSError, ValueError, IndexError, TypeError, StopIteration):
                    pass
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            pass
    return result

if __name__ == "__main__":
    print(json.dumps(probe(json.loads(sys.argv[1])), ensure_ascii=False))
`;

const nativeKey = terminal => JSON.stringify([terminal?.status ?? null, terminal?.report?.app ?? null, terminal?.report?.msg ?? null, terminal?.turn ?? null]);
const shellOnly = terminal => terminal?.status === "working" && terminal.report?.app === "claude-code"
  && /^[1-9][0-9]* shells? still running$/.test(terminal.report?.msg ?? "");

export function claudeSession(terminal, cache) {
  if (terminal?.program?.key !== "claude" || terminal.state !== "live") return null;
  const item = cache?.[terminal.address];
  if (item?.scope === "interactive") {
    if (!shellOnly(terminal) || item.nativeKey !== nativeKey(terminal) || item.status !== "done" || !item.completedTurn) return null;
  } else if (terminal.status != null) return null;
  return item && item.pid === terminal.foreground?.pid && item.created === terminal.created_ms
    && item.title === terminal.title && Date.now() - item.at < 12000 ? item : null;
}

export function claudeStatus(terminal, fallback, cache) {
  const item = claudeSession(terminal, cache);
  if (fallback === "working" && item?.scope === "interactive") return item.status;
  return fallback && fallback !== "unknown" ? fallback : item?.status ?? fallback;
}

export function claudeAgents(rows, all, cache) {
  const records = new Map(all.map(t => [t.address, t]));
  return rows.map(a => {
    const status = claudeStatus(records.get(a.address), a.status, cache);
    const item = claudeSession(records.get(a.address), cache);
    return status === a.status ? a : { ...a, status:status === "done" && a.focused ? "idle" : status, statusDetail:item?.detail };
  });
}

export function claudeTabStatus(tab, panels, records, cache) {
  const rank = { blocked:4, done:3, working:2, idle:1 };
  return panels.filter(p => p.tab === tab.id).reduce((status, p) => {
    const next = claudeStatus(records.get(p.terminal), p.status, cache);
    return (rank[next] ?? 0) > (rank[status] ?? 0) ? next : status;
  }, tab.status);
}

export class ClaudeStatus {
  constructor(api) { this.api = api; this.busy = false; }

  refresh(cx) {
    if (this.busy || !cx?.spawn) return;
    const { terminals, shared, setShared, exec } = this.api;
    const all = terminals().filter(t => t.state === "live" && t.program?.key === "claude"
      && (t.status == null || shellOnly(t)) && t.foreground?.pid && t.title);
    if (!all.length) {
      if (Object.keys(shared(CLAUDE_KEY) ?? {}).length) setShared(CLAUDE_KEY, {});
      return;
    }
    const fingerprint = JSON.stringify(all.map(t => [t.address, t.foreground.pid, t.created_ms, t.title, nativeKey(t)]));
    const lease = shared("claude.status-probe");
    if (lease?.fingerprint === fingerprint && Date.now() - lease.at < 5000) return;
    setShared("claude.status-probe", { fingerprint, at:Date.now() });
    const groups = new Map();
    for (const t of all) {
      const on = t.address.includes("/") ? t.address.split("/")[0] : "";
      if (!groups.has(on)) groups.set(on, []);
      groups.get(on).push({ address:t.address, pid:t.foreground.pid, created:t.created_ms, title:t.title,
        nativeStatus:t.status ?? null, nativeMessage:t.report?.msg ?? null, nativeKey:nativeKey(t) });
    }
    this.busy = true;
    cx.spawn(async cx => {
      try {
        await Promise.all([...groups].map(async ([on, items]) => {
          let found = {};
          try {
            const result = await exec("python3", ["-c", CLAUDE_PROBE, JSON.stringify(items)], { on:on || null, timeout:12000 });
            if (result.code === 0) found = JSON.parse(result.stdout);
          } catch {}
          const live = new Map(terminals().map(t => [t.address, t]));
          const cache = { ...shared(CLAUDE_KEY) };
          for (const item of items) {
            const t = live.get(item.address), entry = found?.[item.address];
            if (t?.foreground?.pid !== item.pid || t.created_ms !== item.created || t.title !== item.title || nativeKey(t) !== item.nativeKey) continue;
            if (entry?.pid === item.pid && entry.created === item.created && entry.title === item.title
              && typeof entry.session === "string" && ["working", "blocked", "done", "idle"].includes(entry.status))
              cache[item.address] = { ...entry, at:Date.now() };
            else delete cache[item.address];
          }
          for (const address of Object.keys(cache)) if (!claudeSession(live.get(address), cache)) delete cache[address];
          setShared(CLAUDE_KEY, cache);
        }));
      } finally { this.busy = false; cx.notify(); }
    });
  }
}
