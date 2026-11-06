// Shared by the sidebar and tab bar. No process input or core status writes.
export const SESSION_KEY = "traex.session-titles";
export const PROBE = String.raw`import json, os, re, sqlite3, subprocess, sys
from pathlib import Path

PROC_ROOT = Path("/proc")
UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"

def active_session(pid):
    # Inspect only this foreground process's open files. Neither cwd nor the
    # launch-time resume argument identifies a session after an in-app switch.
    if PROC_ROOT.exists():
        proc = PROC_ROOT / str(pid)
        if (proc / "exe").resolve().name not in ("traex", "traecli"):
            return None
        paths = []
        for fd in (proc / "fd").iterdir():
            try:
                paths.append(os.readlink(fd))
            except OSError:
                pass
    else:
        command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=2)
        if Path(command.stdout.strip()).name not in ("traex", "traecli"):
            return None
        files = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=3)
        paths = [line[1:] for line in files.stdout.splitlines() if line.startswith("n")]
    sessions = set()
    for path in paths:
        # Older CLI builds keep a per-session writer lock rather than a rollout
        # descriptor open. The process-owned lock identifies the same session.
        lock = re.search(r"/thread-writer-locks/(" + UUID + r")\.lock$", path)
        if lock:
            sessions.add((path.split("/thread-writer-locks/", 1)[0], lock.group(1).lower()))
        if "/sessions/" not in path:
            continue
        match = re.search(r"rollout-.*?-(" + UUID + r")(?:_" + UUID + r")?\.jsonl(?:\.lock)?$", path)
        if match:
            sessions.add((path.split("/sessions/", 1)[0], match.group(1).lower()))
    # Multiple open sessions are ambiguous: never use the newest session of a
    # workspace, which could belong to another panel or a background agent.
    return next(iter(sessions)) if len(sessions) == 1 else None

def session_name(root, session):
    root = Path(root)
    fallback = None
    for path in sorted(root.glob("state_*.sqlite"), key=lambda p: int(re.search(r"state_(\d+)", p.name).group(1)), reverse=True):
        try:
            db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
            try:
                db.execute("PRAGMA query_only=ON")
                columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                if "name" in columns:
                    row = db.execute("SELECT name FROM threads WHERE id=?", (session,)).fetchone()
                    if row and row[0] and row[0].strip():
                        return row[0].strip()[:240]
                if "title" in columns:
                    row = db.execute("SELECT substr(title,1,160) FROM threads WHERE id=?", (session,)).fetchone()
                    if row and row[0] and row[0].strip():
                        fallback = row[0].strip().splitlines()[0]
            finally:
                db.close()
        except (OSError, sqlite3.Error):
            continue
        break
    # The index also carries explicit names on older CLI database schemas.
    try:
        with (root / "session_index.jsonl").open("rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4 * 1024 * 1024))
            lines = f.read().decode("utf-8", errors="replace").splitlines()
        for line in reversed(lines):
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("id") == session and isinstance(row.get("thread_name"), str) and row["thread_name"].strip():
                return row["thread_name"].strip()[:240]
    except OSError:
        pass
    return fallback

result = {}
for item in json.loads(sys.argv[1])[:64]:
    try:
        pid = item["pid"]
        if not isinstance(pid, int) or pid <= 0:
            continue
        active = active_session(pid)
        if not active:
            continue
        name = session_name(*active)
        # Recheck after reading: the user could have switched sessions meanwhile.
        if name and active_session(pid) == active:
            result[item["address"]] = {"pid": pid, "created": item.get("created"), "session": active[1], "name": name}
    except (OSError, ValueError, subprocess.SubprocessError):
        continue
print(json.dumps(result, ensure_ascii=False))
`;

export function sessionTitle(terminal, cache) {
  if (terminal?.program?.key !== "traex" || terminal.state !== "live") return null;
  const item = cache?.[terminal.address];
  return item && item.pid === terminal.foreground?.pid && item.created === terminal.created_ms
    && Date.now() - item.at < 20000 ? item.name : null;
}

export class SessionTitles {
  constructor(api) { this.api = api; this.busy = false; }
  refresh(cx) {
    if (this.busy || !cx?.spawn) return;
    const { terminals, shared, setShared, exec } = this.api;
    const all = terminals().filter(t => t.state === "live" && t.program?.key === "traex" && t.foreground?.pid);
    const groups = new Map();
    for (const t of all) {
      const on = t.address.includes("/") ? t.address.split("/")[0] : "";
      if (!groups.has(on)) groups.set(on, []);
      groups.get(on).push({ address:t.address, pid:t.foreground.pid, created:t.created_ms });
    }
    const fingerprint = JSON.stringify(all.map(t => [t.address, t.foreground.pid, t.created_ms]));
    const lease = shared("traex.session-probe");
    const now = Date.now();
    if (lease?.fingerprint === fingerprint && now - lease.at < 5000) return;
    if (!all.length) {
      if (Object.keys(shared(SESSION_KEY) ?? {}).length) setShared(SESSION_KEY, {});
      return;
    }
    setShared("traex.session-probe", { fingerprint, at:now });
    this.busy = true;
    cx.spawn(async cx => {
      try {
        await Promise.all([...groups].map(async ([on, items]) => {
          let found = {};
          try {
            const result = await exec("python3", ["-c", PROBE, JSON.stringify(items)], { on:on || null, timeout:8000 });
            if (result.code !== 0) return;
            found = JSON.parse(result.stdout);
          } catch { return; }
          const live = new Map(terminals().map(t => [t.address, t]));
          const cache = { ...shared(SESSION_KEY) };
          for (const item of items) {
            const t = live.get(item.address), entry = found[item.address];
            if (t?.program?.key === "traex" && t.state === "live" && t.foreground?.pid === item.pid && t.created_ms === item.created) {
              if (entry?.pid === item.pid && entry.created === item.created && typeof entry.name === "string" && entry.name.trim())
                cache[item.address] = { ...entry, at:Date.now() };
              else delete cache[item.address];
            }
          }
          for (const address of Object.keys(cache)) {
            if (live.get(address)?.program?.key !== "traex" || live.get(address)?.state !== "live") delete cache[address];
          }
          setShared(SESSION_KEY, cache);
        }));
      } finally { this.busy = false; cx.notify(); }
    });
  }
}
