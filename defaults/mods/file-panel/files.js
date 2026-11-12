// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, openOverlay } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const PREVIEW_LIMIT = 400000;
const markdownFile = path => /\.(md|markdown|mdown|mkd|mkdn|mdwn)$/i.test(path);

function entryPaths(root, path) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  const separator = windows && root.includes("\\") ? "\\" : "/";
  const relative = windows ? path.split("/").join(separator) : path;
  const base = windows ? root.replace(/[\\/]+$/, "") : root.replace(/\/+$/, "");
  return { relative: relative || ".", absolute: path ? base + separator + relative : root };
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

async function resolveFolder(path, base, on) {
  const windowsFolder = async () => {
    const quote = value => "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p,$base) "
      + "if ($p -eq '~') { $p=$HOME } elseif ($p.StartsWith('~/') -or $p.StartsWith('~\\')) { $p=[IO.Path]::Combine($HOME,$p.Substring(2)) } "
      + "elseif (-not [IO.Path]::IsPathRooted($p)) { $p=[IO.Path]::Combine($base,$p) }; "
      + "$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; if (-not $item.PSIsContainer) { throw 'Not a folder' }; "
      + "[Console]::Write($item.FullName) } " + quote(path) + " " + quote(base || "");
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
    if (r.code !== 0 || !r.stdout) throw new Error(r.stderr || "Cannot open this folder");
    return r.stdout;
  };
  if (!on && window()?.platform === "windows") return windowsFolder();
  const script = 'case "$1" in "~") p=$HOME ;; "~/"*) p=$HOME/${1#??} ;; /*) p=$1 ;; *) p=$2/$1 ;; esac; CDPATH=; export CDPATH; cd -L "$p" && pwd -L';
  let r;
  try { r = await exec("sh", ["-c", script, "files-path", path, base || "/"], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsFolder();
    throw e;
  }
  if (r.code !== 0 || !r.stdout) throw new Error(r.stderr || "Cannot open this folder");
  return r.stdout.replace(/\n$/, "");
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.roots = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.pathInput = InputState.new({ placeholder: "输入文件夹路径，回车打开" });
    this.pathInput.on("change", (_e, cx) => { this.navigation = null; this.pathError = null; cx.notify(); });
    this.pathInput.on("submit", (_e, cx) => this.navigate(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => { this.refresh(cx); if (this.markdown) this.loadFile(cx); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) { this.refresh(cx); if (this.markdown) this.loadFile(cx); } } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && JSON.stringify(this.browseLocation()) === context.key;
  }

  scope(where = location()) { return JSON.stringify([where.on, where.space]); }

  browseLocation() {
    const where = location(), root = this.roots?.get(this.scope(where));
    return root ? { ...where, cwd: root } : where;
  }

  navigate(cx) {
    const value = this.pathInput.value(), where = location(), scope = this.scope(where);
    if (!value.trim()) { this.pathError = "请输入文件夹路径"; cx.notify(); return; }
    if (this.navigation?.value === value && this.navigation.scope === scope) return;
    const request = { value, scope, base: this.browseLocation().cwd, on: where.on };
    this.navigation = request; this.pathError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const root = await resolveFolder(value, request.base, request.on);
        if (this.navigation !== request || this.scope() !== scope || this.pathInput.value() !== value) return;
        this.roots.set(scope, root);
        this.refresh(cx);
        this.show(null);
        this.pathInput.set_value(root);
      } catch (e) {
        if (this.navigation === request && this.scope() === scope && this.pathInput.value() === value)
          this.pathError = `无法打开目录：${e.message ?? e}`;
      } finally {
        if (this.navigation === request) this.navigation = null;
        cx.notify();
      }
    });
  }

  follow(cx) {
    this.navigation = null; this.pathError = null;
    this.roots.delete(this.scope());
    this.refresh(cx); this.show(null);
    this.pathInput.set_value(this.root ?? "");
    cx.notify();
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const where = this.browseLocation(), { cwd, on, space } = where, next = JSON.stringify(where);
    if (next !== this.context?.key) {
      if (this.context && this.scope(this.context) !== this.scope(where)) this.navigation = null;
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      this.pathInput?.set_value(cwd ?? "");
      this.pathError = null;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.fileRequest = (this.fileRequest ?? 0) + 1;
    this.code?.release(); this.code = null; this.text = null; this.file = path; this.fileError = null;
    this.markdown = Boolean(path && markdownFile(path)); this.mode = "preview";
    this.reading = false; this.truncated = false;
    if (path && cx) this.loadFile(cx);
  }

  previewError(message) {
    this.code?.release(); this.code = null; this.text = null; this.fileError = message;
  }

  openPanel(asTab = false) {
    if (!this.file || this.detached) return;
    const space = spaces().find(s => s.id === (this.context.space ?? location().space));
    if (!space) return;
    const tab = space.tabs?.find(t => t.active);
    const pane = panes().find(p => p.tab === tab?.id && p.focused) ?? panes().find(p => p.tab === tab?.id);
    const title = this.file.split("/").pop(), path = `${this.root}/${this.file}`;
    const props = { path, on: this.on ?? null, title, folder: path.slice(0, path.lastIndexOf("/")) || "/" };
    if (!asTab && pane) run("pane.split", { pane: pane.pane, direction: "right", mod: "file-panel", props });
    else run("tab.new", { space: space.id, name: title, mod: "file-panel", props });
  }

  loadFile(cx) {
    if (!this.file || this.reading) return;
    const context = this.context, root = this.root, on = this.on, path = this.file;
    const request = this.fileRequest = (this.fileRequest ?? 0) + 1;
    const current = () => this.fileRequest === request && this.file === path && this.current(context);
    this.reading = true;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (!current()) return;
        if (text === null) { this.previewError("This file is no longer available"); return; }
        if (text.includes("\0")) { this.previewError("Binary file · no text preview"); return; }
        const truncated = text.length > PREVIEW_LIMIT;
        const value = truncated ? text.slice(0, PREVIEW_LIMIT) + "\n… (file truncated)" : text;
        this.fileError = null; this.truncated = truncated;
        if (this.text === value && this.code) return;
        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        const code = EditorState.new({ language: this.markdown ? "markdown" : LANG[ext] ?? ext, readonly: true,
          value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.code?.release(); this.code = code; this.text = value;
      } catch { if (current()) this.previewError("Cannot preview this file (binary, too large, or unreadable)"); }
      finally { if (current()) this.reading = false; cx.notify(); }
    });
  }

  pathMenu(path, cx, directory = true) {
    if (!this.root) return;
    // Capture the clicked tree root now: the popup must not follow focus/cwd.
    const paths = entryPaths(this.root, path);
    cx.stop_propagation();
    openOverlay({ mod: "file-path-menu", kind: "popup", width: 210, height: 107,
      props: { ...paths, on:this.on ?? null, directory, download:true } });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => this.pathMenu(path, cx, entry.dir))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (!this.detached && JSON.stringify(this.browseLocation()) !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file) && !this.detached, el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child(this.detached ? "File" : "Files"))
        .child(div().id("files-root-path").flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).tooltip(this.file ?? this.root ?? "")
          .when(!this.file && !this.detached && Boolean(this.root), el => el.on_mouse_down("right", (_e, cx) => this.pathMenu("", cx)))
          .child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.detached, el => el.child(div().id("files-downloads").px(7).py(4).rounded(5).flex_none().text_size(12).cursor_pointer().text_color(t.muted)
          .tooltip("查看下载任务和进度").hover(s => s.bg(t.hover))
          .on_click(() => openOverlay({ mod:"file-download", kind:"window", key:"file-download-history", width:360, props:{role:"history"} })).child("下载")))
        .when(Boolean(this.file), el => el.child(div().id("files-refresh").w(20).flex_none().text_size(16).cursor_pointer().text_color(t.muted).tooltip("Refresh file")
          .on_click((_e, cx) => { this.loadFile(cx); cx.notify(); }).child("↻"))))
      .when(!this.detached, el => el
        .child(h_flex().h(39).flex_none().px(8).gap(5).items_center().border_b(1).border_color(t.border)
          .child(Input.new(this.pathInput).id("files-path-input").flex_1().min_w(0).h(29).px(7).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(12))
          .child(div().id("files-path-open").px(7).py(5).rounded(5).cursor_pointer().text_size(11.5).text_color(t.muted)
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.navigate(cx)).child(this.navigation ? "打开中…" : "打开"))
          .when(this.roots.has(this.scope()), el => el.child(div().id("files-path-follow").px(7).py(5).rounded(5).cursor_pointer().text_size(11.5)
            .text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("恢复跟随当前终端目录")
            .on_click((_e, cx) => this.follow(cx)).child("跟随终端"))))
        .when(Boolean(this.pathError), el => el.child(div().px(9).py(6).flex_none().text_size(11.5).text_color(t.blocked).child(this.pathError))))
      .when(Boolean(this.file) && (this.markdown || !this.detached), el => el.child(h_flex().h(34).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .when(this.markdown, el => el.children(["preview", "source"].map(mode => div().id(`files-mode-${mode}`).px(10).py(4).rounded(5).cursor_pointer()
          .bg(this.mode === mode ? t.hover : "#00000000").text_color(this.mode === mode ? t.foreground : t.dim)
          .on_click((_e, cx) => { this.mode = mode; cx.notify(); }).child(mode === "preview" ? "Preview" : "Source"))))
        .child(div().flex_1())
        .when(!this.detached, el => el
          .child(div().id("files-open-panel").px(8).py(4).rounded(5).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("Open this file beside the focused panel")
            .on_click(() => this.openPanel()).child("Panel"))
          .child(div().id("files-open-tab").px(8).py(4).rounded(5).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("Open this file in a new tab")
            .on_click(() => this.openPanel(true)).child("New tab")))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && this.truncated, el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.dim).child("Large file · preview truncated")))
      .when(Boolean(this.file), el => el.child(this.markdown && this.mode !== "source" && this.text !== null
        ? TextView.markdown(`files-markdown-${this.context.key}-${this.file}`, this.text).selectable(true).scrollable(true).flex_1().min_h(0).w_full().p(14)
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
