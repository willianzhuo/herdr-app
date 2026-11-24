// Shared by the sidebar, tab bar and pane headers.
export const SESSION_KEY = "agent.session-titles";
export const SESSION_PROBE_KEY = "agent.session-probe";
export const PROBE = String.raw`import json, os, re, sqlite3, subprocess, sys
from pathlib import Path

PROC_ROOT = Path("/proc")
UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
PROGRAMS = {"traex": ("traex", "traecli"), "antigravity": ("agy",)}

def active_session(pid, program):
    # Inspect only this foreground process's open files. Neither cwd nor the
    # launch-time resume argument identifies a session after an in-app switch.
    if PROC_ROOT.exists():
        proc = PROC_ROOT / str(pid)
        if (proc / "exe").resolve().name not in PROGRAMS[program]:
            return None
        paths = []
        for fd in (proc / "fd").iterdir():
            try:
                paths.append(os.readlink(fd))
            except OSError:
                pass
    else:
        command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=2)
        if Path(command.stdout.strip()).name not in PROGRAMS[program]:
            return None
        files = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=3)
        paths = [line[1:] for line in files.stdout.splitlines() if line.startswith("n")]
    sessions = set()
    for path in paths:
        if program == "antigravity":
            # AGY keeps the current conversation's presence lock open. /resume
            # and /fork can change it while the process and launch argv stay put.
            presence = re.fullmatch(r"(.*/antigravity-cli)/presence/(" + UUID + r")\.lock", path)
            if presence:
                sessions.add((presence.group(1), presence.group(2).lower()))
            continue
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

def antigravity_name(root, session):
    path = Path(root) / "conversation_summaries.db"
    wal = path.with_name(path.name + "-wal")
    shm = path.with_name(path.name + "-shm")
    # Immutable reads work with SQLite builds that cannot open a WAL-mode
    # database without its sidecars. A live WAL needs a normal read-only view.
    # Only open that view when both sidecars already exist.
    def pending_wal():
        try:
            return wal.stat().st_size > 0
        except FileNotFoundError:
            return False
    live = pending_wal()
    if live and not shm.is_file():
        return None
    before = path.stat()
    uri = path.as_uri() + ("?mode=ro" if live else "?mode=ro&immutable=1")
    try:
        db = sqlite3.connect(uri, uri=True, timeout=0.2)
        try:
            row = db.execute("SELECT substr(title, 1, 240) FROM conversation_summaries WHERE conversation_id=?", (session,)).fetchone()
        finally:
            db.close()
    except sqlite3.Error:
        return None
    if not live:
        after = path.stat()
        if pending_wal() or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            return None
    return row[0].strip() if row and isinstance(row[0], str) else None

def traex_name(root, session):
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
        program = item.get("program")
        if not isinstance(pid, int) or pid <= 0 or program not in PROGRAMS:
            continue
        active = active_session(pid, program)
        if not active:
            continue
        name = (antigravity_name if program == "antigravity" else traex_name)(*active)
        # Recheck after reading: the user could have switched sessions meanwhile.
        if name and active_session(pid, program) == active:
            result[item["address"]] = {"pid": pid, "created": item.get("created"), "program": program, "session": active[1], "name": name}
    except (OSError, ValueError, subprocess.SubprocessError):
        continue
print(json.dumps(result, ensure_ascii=False))
`;

export function sessionTitle(terminal, cache) {
  if (!supported(terminal)) return null;
  const item = cache?.[terminal.address];
  return item && item.program === terminal.program.key && item.pid === terminal.foreground?.pid && item.created === terminal.created_ms
    && Date.now() - item.at < 20000 ? item.name : null;
}

const supported = t => t?.state === "live" && ["traex", "antigravity"].includes(t.program?.key);

export class SessionTitles {
  constructor(api) { this.api = api; this.busy = false; }
  refresh(cx) {
    if (this.busy || !cx?.spawn) return;
    const { terminals, shared, setShared, exec } = this.api;
    const all = terminals().filter(t => supported(t) && t.foreground?.pid);
    const groups = new Map();
    for (const t of all) {
      const on = t.address.includes("/") ? t.address.split("/")[0] : "";
      if (!groups.has(on)) groups.set(on, []);
      groups.get(on).push({ address:t.address, pid:t.foreground.pid, created:t.created_ms, program:t.program.key });
    }
    const fingerprint = JSON.stringify(all.map(t => [t.address, t.foreground.pid, t.created_ms, t.program.key]));
    const lease = shared(SESSION_PROBE_KEY);
    const now = Date.now();
    if (lease?.fingerprint === fingerprint && now - lease.at < 5000) return;
    if (!all.length) {
      if (Object.keys(shared(SESSION_KEY) ?? {}).length) setShared(SESSION_KEY, {});
      return;
    }
    setShared(SESSION_PROBE_KEY, { fingerprint, at:now });
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
            if (supported(t) && t.program.key === item.program && t.foreground?.pid === item.pid && t.created_ms === item.created) {
              if (entry?.pid === item.pid && entry.created === item.created && entry.program === item.program && typeof entry.name === "string" && entry.name.trim())
                cache[item.address] = { ...entry, at:Date.now() };
              else delete cache[item.address];
            }
          }
          for (const address of Object.keys(cache)) {
            if (!supported(live.get(address))) delete cache[address];
          }
          setShared(SESSION_KEY, cache);
        }));
      } finally { this.busy = false; cx.notify(); }
    });
  }
}
