import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const loadDirectory = (exec: Function, platform: string) => new Function("exec", "window", `${directorySource}; return directory;`)(exec, () => ({ platform }));
const directory = loadDirectory(
  async (command: string, args: string[]) => {
    // Hidden like the app's spawns: a visible console would give PowerShell UTF-8 and hide code page bugs.
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  process.platform === "win32" ? "windows" : process.platform,
);

test("Files retries a remote Windows directory with PowerShell on that machine", async () => {
  const calls: { command: string; args: string[]; on: string }[] = [];
  const list = loadDirectory(async (command: string, args: string[], options: { on: string }) => {
    calls.push({ command, args, on: options.on });
    if (command === "sh") throw new Error("herdr.exec: cannot start sh: program not found");
    return { code: 0, stdout: '{"name":"中文.txt","dir":false}', stderr: "" };
  }, "linux");
  const path = "C:/O’Brien's $folder";
  expect(await list(path, "winvm")).toEqual([{ name: "中文.txt", dir: false }]);
  expect(calls.map(c => [c.command, c.on])).toEqual([["sh", "winvm"], ["powershell", "winvm"]]);
  expect(calls[0].args.at(-1)).toBe(path);
  expect(calls[1].args.at(-1)).toContain("'C:/O’’Brien''s $folder'");
  expect(calls[1].args.at(-1)).toContain("[Console]::OutputEncoding");
});

test("Files does not mask remote command failures with PowerShell", async () => {
  for (const failure of [new Error("connection lost"), new Error("cannot start sh: permission denied"), { code: 1, stdout: "", stderr: "folder denied" }]) {
    const calls: string[] = [];
    const list = loadDirectory(async (command: string) => {
      calls.push(command);
      if (failure instanceof Error) throw failure;
      return failure;
    }, "linux");
    await expect(list("/folder", "linuxvm")).rejects.toThrow(failure instanceof Error ? failure.message : failure.stderr);
    expect(calls).toEqual(["sh"]);
  }
});

test("Files keeps remote POSIX directory listings on sh", async () => {
  const calls: string[] = [];
  const list = loadDirectory(async (command: string) => {
    calls.push(command);
    return { code: 0, stdout: "d\0folder\0f\0file.txt\0", stderr: "" };
  }, "windows");
  expect(await list("/folder", "linuxvm")).toEqual([{ name: "folder", dir: true }, { name: "file.txt", dir: false }]);
  expect(calls).toEqual(["sh"]);
});

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)", "O’Brien ‘quoted’ ‚low‛"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files preserves Unicode names when listing and expanding folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-unicode-"));
  try {
    const folder = "中文目录 O'Brien (测试)", file = "项目说明.txt", child = "子文件.txt";
    await mkdir(join(root, folder));
    await writeFile(join(root, file), "hello");
    await writeFile(join(root, folder, child), "hello");
    const entries = await directory(root, null);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ name: folder, dir: true });
    expect(entries).toContainEqual({ name: file, dir: false });
    expect(await directory(join(root, folder), null)).toEqual([{ name: child, dir: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files follows directory links one level at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-links-"));
  try {
    const target = join(root, "versions");
    await mkdir(target);
    for (let minor = 1; minor <= 9; minor++) {
      await mkdir(join(target, `0.${minor}.0`));
    }
    await writeFile(join(target, "0.9.0", "STORY.md"), "story preview");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "ordinary.txt"), "ordinary");
    await symlink("versions", join(root, ".kb"), "dir");
    if (process.platform === "win32") await symlink(target, join(root, "junction"), "junction");
    await symlink(join(root, "ordinary.txt"), join(root, "file-link"), "file");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    // A cycle must be listed without recursively walking it.
    await symlink(target, join(target, "loop"), "dir");

    const entries = await directory(root, null);
    expect(entries).toHaveLength(process.platform === "win32" ? 7 : 6);
    if (process.platform === "win32") expect(entries).toContainEqual({ name: "junction", dir: true });
    expect(entries).toContainEqual({ name: ".kb", dir: true });
    expect(entries).toContainEqual({ name: "versions", dir: true });
    expect(entries).toContainEqual({ name: ".hidden", dir: true });
    expect(entries).toContainEqual({ name: "ordinary.txt", dir: false });
    expect(entries).toContainEqual({ name: "file-link", dir: false });
    expect(entries).toContainEqual({ name: "dangling", dir: false });
    const versions = await directory(join(root, ".kb"), null);
    expect(versions).toHaveLength(10);
    for (let minor = 1; minor <= 9; minor++) {
      expect(versions).toContainEqual({ name: `0.${minor}.0`, dir: true });
    }
    expect(versions).toContainEqual({ name: "loop", dir: true });
    expect(await directory(join(root, ".kb", "0.9.0"), null)).toEqual([{ name: "STORY.md", dir: false }]);
    expect(await readFile(join(root, ".kb", "0.9.0", "STORY.md"), "utf8")).toBe("story preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Render the real Files view with native-element stand-ins; click its actual
// mode/refresh/back handlers and control file reads independently of the tree.
function previewHarness(reader: () => Promise<string | null>) {
  const tasks: Promise<unknown>[] = [], reads: unknown[] = [], editors: any[] = [];
  let load = reader;
  const element = (kind: string, value?: unknown): any => {
    const node: any = {kind, value, kids:[], methods:new Map()};
    const proxy: any = new Proxy(node, {get(target, name: string) {
      if (name in target) return target[name];
      return (...args: any[]) => {
        if (name === "when") return args[0] ? args[1](proxy) : proxy;
        if (name === "child") target.kids.push(args[0]);
        if (name === "children") target.kids.push(...args[0]);
        target.methods.set(name,args); return proxy;
      };
    }});
    return proxy;
  };
  const context = {cwd:"/remote/work",on:"box",space:"space"};
  const theme = new Proxy({}, {get:()=>"#112233"});
  const Files = new Function("View","div","svg","v_flex","h_flex","Editor","EditorState","TextView",
    "spaces","panes","focused","exec","readTextFile","watchFolder","theme","settings","window",
    source.replace(/^import .*;\n/gm, "").replace("export default class Files", "class Files") + ";return Files;")(
      class {}, () => element("div"), () => element("svg"), () => element("column"), () => element("row"),
      {new:(state: any)=>element("editor",state)}, {new:(options: any)=>{const state={...options,released:false,release(){this.released=true;}};editors.push(state);return state;}},
      {markdown:(id: string,text: string)=>element("markdown",text).id(id)},
      () => [{id:"space",active:true,machine:"box",folder:context.cwd}], () => [{pane:"pane",cwd:context.cwd}], () => ({pane:"pane"}),
      async()=>({code:1}), async(...args: any[])=>{reads.push(args);return load();}, async()=>{}, () => theme,
      () => ({font_family:"Monospace"}), () => ({platform:"linux"}),
  );
  const view = new Files();
  Object.assign(view,{context:{...context,key:JSON.stringify(context)},root:context.cwd,on:context.on,entries:new Map(),folders:new Set(),marks:{}});
  const cx: any = {notify(){},spawn(fn: any){tasks.push(fn(cx));}};
  const flatten = (node: any): any[] => typeof node === "object" && node !== null ? [node,...(node.kids ?? []).flatMap(flatten)] : [];
  const nodes = () => flatten(view.render(cx));
  const click = (id: string) => nodes().find(n=>n.methods?.get("id")?.[0]===id).methods.get("on_click")[0]({},cx);
  return {view,cx,reads,editors,nodes,click,setReader:(r: typeof reader)=>{load=r;},flush:async()=>{await Promise.all(tasks.splice(0));}};
}

test("Markdown defaults to selectable rendered preview and switches to read-only source without rereading", async () => {
  const text="# 标题\n\n**Bold** and `code`\n\n- first\n- second\n\n```js\nconst answer = 42;\n```";
  const h=previewHarness(async()=>text);
  h.view.show("README.MD",h.cx);await h.flush();
  const preview=h.nodes().find(n=>n.kind==="markdown");
  expect(preview.value).toBe(text);
  expect(preview.methods.get("selectable")).toEqual([true]);
  expect(preview.methods.get("scrollable")).toEqual([true]);
  expect(h.reads).toEqual([["/remote/work/README.MD",{on:"box"}]]);
  h.click("files-mode-source");
  expect(h.nodes().find(n=>n.kind==="editor").value).toMatchObject({readonly:true,language:"markdown",value:text});
  h.click("files-mode-preview");
  expect(h.nodes().some(n=>n.kind==="markdown")).toBe(true);
  expect(h.reads).toHaveLength(1);
  h.click("files-back");
  expect(h.view.file).toBeNull();expect(h.editors[0].released).toBe(true);
});

test("switching away and reopening the same Markdown file ignores its old in-flight read", async () => {
  let old!: (value: string)=>void;
  const h=previewHarness(()=>new Promise(resolve=>{old=resolve;}));
  h.view.show("guide.md",h.cx);
  h.view.show(null);
  h.setReader(async()=>"# New");h.view.show("guide.md",h.cx);
  old("# Stale");await h.flush();
  expect(h.view.text).toBe("# New");
  expect(h.view.reading).toBe(false);
});

test("Markdown refresh preserves unchanged editor state, updates content and handles deletion/binary data", async () => {
  const h=previewHarness(async()=>"# Original");h.view.show("guide.markdown",h.cx);await h.flush();
  const original=h.view.code;
  h.click("files-refresh");await h.flush();expect(h.view.code).toBe(original);
  h.setReader(async()=>"# Changed");h.click("files-refresh");await h.flush();
  expect(h.view.text).toBe("# Changed");expect(original.released).toBe(true);
  h.setReader(async()=>null);h.click("files-refresh");await h.flush();
  expect(h.view.text).toBeNull();expect(h.view.fileError).toContain("no longer available");
  h.setReader(async()=>"binary\0data");h.click("files-refresh");await h.flush();
  expect(h.view.code).toBeNull();expect(h.view.fileError).toContain("Binary file");
});

test("empty/large Markdown stays bounded and ordinary files keep source preview", async () => {
  const h=previewHarness(async()=>"");h.view.show("empty.mdown",h.cx);await h.flush();
  expect(h.nodes().find(n=>n.kind==="markdown").value).toBe("");
  h.setReader(async()=>"x".repeat(400001));h.view.show("large.md",h.cx);await h.flush();
  expect(h.view.truncated).toBe(true);expect(h.view.text.length).toBeLessThan(400050);
  h.setReader(async()=>'{"ok":true}');h.view.show("data.JSON",h.cx);await h.flush();
  expect(h.nodes().some(n=>n.kind==="markdown")).toBe(false);
  expect(h.nodes().find(n=>n.kind==="editor").value.language).toBe("json");
});
