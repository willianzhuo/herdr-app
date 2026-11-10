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
function element(kind: string, value?: unknown): any {
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
}
const flatten = (node: any): any[] => typeof node === "object" && node !== null ? [node,...(node.kids ?? []).flatMap(flatten)] : [];

function previewHarness(reader: () => Promise<string | null>, fixed?: any) {
  const tasks: Promise<unknown>[] = [], reads: unknown[] = [], editors: any[] = [], runs: any[] = [], overlays: any[] = [];
  let load = reader;
  let panelProps = fixed;
  let browsingFolder = "/remote/work";
  let machine = "box", workspace = "space";
  let execute: Function = async()=>({code:1});
  const context = {cwd:"/remote/work",on:"box",space:"space"};
  const theme = new Proxy({}, {get:()=>"#112233"});
  const Files = new Function("View","div","svg","v_flex","h_flex","Editor","EditorState","TextView","Input","InputState",
    "spaces","panes","focused","exec","readTextFile","watchFolder","theme","settings","window","run","openOverlay",
    source.replace(/^import .*;\n/gm, "").replace("export default class Files", "class Files") + ";return Files;")(
      class {}, () => element("div"), () => element("svg"), () => element("column"), () => element("row"),
      {new:(state: any)=>element("editor",state)}, {new:(options: any)=>{const state={...options,released:false,release(){this.released=true;}};editors.push(state);return state;}},
      {markdown:(id: string,text: string)=>element("markdown",text).id(id)},
      {new:(state:any)=>element("input",state)}, {new:(options:any)=>({text:options.value??"",handlers:new Map(),value(){return this.text;},set_value(v:string){this.text=v;},on(k:string,fn:any){this.handlers.set(k,fn);}})},
      () => [{id:workspace,active:true,machine,folder:browsingFolder,tabs:[{id:"tab",active:true}]}], () => [{pane:"pane",tab:"tab",focused:true,cwd:browsingFolder}], () => ({pane:"pane"}),
      (...args:any[])=>execute(...args), async(...args: any[])=>{reads.push(args);return load();}, async()=>{}, () => theme,
      () => ({font_family:"Monospace"}), () => ({platform:"linux"}), (...args: any[])=>runs.push(args), (spec:any)=>overlays.push(spec),
  );
  const Panel = fixed ? new Function("Files","div","props",panelSource.replace(/^import .*;\n/gm, "").replace("export default class FilePanel","class FilePanel")+";return FilePanel;")(Files,()=>element("div"),()=>panelProps) : Files;
  const view = new Panel();
  Object.assign(view,{context:{...context,key:JSON.stringify(context)},root:context.cwd,on:context.on,entries:new Map(),folders:new Set(),marks:{}});
  const cx: any = {notify(){},stop_propagation(){},timer:{every(){}},spawn(fn: any){tasks.push(fn(cx));}};
  view.init({},cx);
  const nodes = () => flatten(view.render(cx));
  const click = (id: string) => nodes().find(n=>n.methods?.get("id")?.[0]===id).methods.get("on_click")[0]({},cx);
  return {view,cx,reads,editors,nodes,click,runs,overlays,setExec:(fn:Function)=>{execute=fn;},setReader:(r: typeof reader)=>{load=r;},setProps:(p:any)=>{panelProps=p;},switchFolder:(folder="/other/project")=>{browsingFolder=folder;},switchScope:(on:string,space:string)=>{machine=on;workspace=space;},flush:async()=>{while(tasks.length)await Promise.all(tasks.splice(0));}};
}

const panelSource = await readFile(new URL("../defaults/mods/file-panel/main.js",import.meta.url),"utf8");

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

test("file actions create real mod panes/tabs with a captured path and machine, not file content", async () => {
  const h=previewHarness(async()=>"# Private content");h.view.show("docs/Guide.MD",h.cx);await h.flush();
  h.click("files-open-panel");h.click("files-open-tab");
  const props={path:"/remote/work/docs/Guide.MD",on:"box",title:"Guide.MD",folder:"/remote/work/docs"};
  expect(h.runs).toEqual([
    ["pane.split",{pane:"pane",direction:"right",mod:"file-panel",props}],
    ["tab.new",{space:"space",name:"Guide.MD",mod:"file-panel",props}],
  ]);
  expect(h.reads).toHaveLength(1);
});

test("independent file panels retain their path/machine across terminal focus and react only to their own props", async () => {
  const h=previewHarness(async()=>"# Own file",{path:"/remote/work/docs/Guide.md",on:"box"});await h.flush();
  h.switchFolder();expect(h.nodes().find(n=>n.kind==="markdown").value).toBe("# Own file");
  expect(h.view.root).toBe("/remote/work/docs");
  expect(h.reads).toEqual([["/remote/work/docs/Guide.md",{on:"box"}]]);
  expect(h.nodes().some(n=>n.methods?.get("id")?.[0]==="files-back")).toBe(false);
  expect(h.nodes().some(n=>n.methods?.get("id")?.[0]==="files-open-panel")).toBe(false);
  h.setProps({path:"C:/Other Folder/README.md",on:"win"});h.nodes();await h.flush();
  expect(h.reads.at(-1)).toEqual(["C:/Other Folder/README.md",{on:"win"}]);
});

test("file panels ship the exact same bounded read-only viewer as Files", async () => {
  expect(await readFile(new URL("../defaults/mods/file-panel/files.js",import.meta.url),"utf8")).toBe(source);
});

test("folder right-click captures the exact tree path and leaves expansion unchanged", async () => {
  const h=previewHarness(async()=>""); await h.flush();
  h.view.entries.set("",[{name:"资料 $folder",dir:true},{name:"plain.txt",dir:false}]);
  h.view.entries.set("资料 $folder",[{name:"O'Brien\\child",dir:true}]);
  h.view.folders.add("资料 $folder");
  const folder=h.nodes().find(n=>n.methods?.get("id")?.[0]==="file-资料 $folder/O'Brien\\child");
  expect(folder.methods.get("on_mouse_down")[0]).toBe("right");
  folder.methods.get("on_mouse_down")[1]({},h.cx);
  expect(h.overlays[0]).toMatchObject({mod:"file-path-menu",kind:"popup",props:{relative:"资料 $folder/O'Brien\\child",absolute:"/remote/work/资料 $folder/O'Brien\\child"}});
  expect([...h.view.folders]).toEqual(["资料 $folder"]);
  expect(h.nodes().find(n=>n.methods?.get("id")?.[0]==="file-plain.txt").methods.has("on_mouse_down")).toBe(false);
  h.nodes().find(n=>n.methods?.get("id")?.[0]==="files-root-path").methods.get("on_mouse_down")[1]({},h.cx);
  expect(h.overlays.at(-1).props).toEqual({relative:".",absolute:"/remote/work"});
  h.switchFolder();h.nodes();await h.flush();
  expect(h.overlays[0].props.absolute).toBe("/remote/work/资料 $folder/O'Brien\\child");

  const paths=new Function(source.slice(source.indexOf("function entryPaths("),source.indexOf("async function directory("))+";return entryPaths;")();
  expect(paths("/","child")).toEqual({relative:"child",absolute:"/child"});
  expect(paths("C:\\Work\\","docs/中文")).toEqual({relative:"docs\\中文",absolute:"C:\\Work\\docs\\中文"});
  expect(paths("C:/Work/","docs/中文").absolute).toBe("C:/Work/docs/中文");
  expect(paths("\\\\server\\share","docs/中文").absolute).toBe("\\\\server\\share\\docs\\中文");
});

test("path popup copies its captured value through the local clipboard and supports keyboard dismissal", async () => {
  const menuSource=await readFile(new URL("../defaults/mods/file-path-menu/main.js",import.meta.url),"utf8");
  let props:any={relative:"docs/中文",absolute:"/remote/work/docs/中文",overlay:"menu1"};
  const writes:string[]=[],closed:string[]=[];
  const Menu=new Function("View","div","v_flex","h_flex","props","closeOverlay","theme",
    menuSource.replace(/^import .*;\n/gm,"").replace("export default class FilePathMenu","class FilePathMenu")+";return FilePathMenu;")(
      class {},()=>element("div"),()=>element("column"),()=>element("row"),()=>props,(id:string)=>closed.push(id),()=>({}));
  const cx={focus_handle:()=>({focus(){}}),write_to_clipboard:(s:string)=>writes.push(s),stop_propagation(){},notify(){}};
  const menu=new Menu();menu.init({},cx);
  // A cwd/focus change while the popup is open must not change the selected path.
  props={relative:"other",absolute:"/other",overlay:"menu1"};
  flatten(menu.render()).find(n=>n.methods?.get("id")?.[0]==="copy-path-relative").methods.get("on_click")[0]({},cx);
  const key=menu.render().methods.get("on_key_down")[0];
  key({key:"down"},cx);key({key:"enter"},cx);key({key:"escape"},cx);
  expect(writes).toEqual(["docs/中文","/remote/work/docs/中文"]);
  expect(closed).toEqual(["menu1","menu1","menu1"]);
});

const loadResolver=(execute:Function,platform="linux")=>new Function("exec","window",`${directorySource};return resolveFolder;`)(execute,()=>({platform}));
test.skipIf(process.platform==="win32")("folder navigation resolves literal, relative, home and symlink paths without shell expansion", async () => {
  const root=await mkdtemp(join(tmpdir(),"herdr-path-"));
  const resolve=loadResolver(async(command:string,args:string[])=>{
    const p=Bun.spawn([command,...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HOME:root}});
    const [code,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    return {code,stdout,stderr};
  });
  try {
    const name="中文 O'Brien $(touch OWNED)\\literal";
    await mkdir(join(root,name));await symlink(name,join(root,"alias"),"dir");
    expect(await resolve(name,root,null)).toBe(join(root,name));
    expect(await resolve(join(root,name),"/",null)).toBe(join(root,name));
    expect(await resolve("~/alias","/",null)).toBe(join(root,"alias"));
    expect(await resolve("~","/",null)).toBe(root);
    expect((await directory(root,null)).some((entry:any)=>entry.name==="OWNED")).toBe(false);
    await writeFile(join(root,"file"),"text");
    await expect(resolve("file",root,null)).rejects.toThrow();
    await expect(resolve("missing",root,null)).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
});

test("folder navigation keeps remote machine and only falls back for a missing POSIX shell", async () => {
  const calls:any[]=[];
  const resolve=loadResolver(async(command:string,args:string[],options:any)=>{
    calls.push({command,args,...options});
    if(command==="sh")throw new Error("cannot start sh: program not found");
    return {code:0,stdout:"C:\\Work\\中文",stderr:""};
  });
  expect(await resolve("中文","C:\\Work","win")).toBe("C:\\Work\\中文");
  expect(calls.map(c=>[c.command,c.on])).toEqual([["sh","win"],["powershell","win"]]);
  expect(calls[1].args.at(-1)).toContain("Get-Item -LiteralPath");
  const unavailable=loadResolver(async()=>{throw new Error("connection lost");});
  await expect(unavailable("/work","/","box")).rejects.toThrow("connection lost");
});

test("Files address bar pins a directory per workspace, validates failures and can follow terminal again", async () => {
  const h=previewHarness(async()=>"");await h.flush();
  const requests:any[]=[];
  h.setExec(async(command:string,args:string[],options:any)=>{
    if(command==="sh"&&args[2]==="files-path") {
      requests.push({value:args[3],base:args[4],...options});
      return args[3]==="missing"?{code:1,stderr:"No such directory"}:{code:0,stdout:"/remote/资料\n"};
    }
    return {code:0,stdout:""};
  });
  h.view.pathInput.set_value("../资料");h.view.pathInput.handlers.get("submit")({},h.cx);await h.flush();
  expect(requests).toEqual([{value:"../资料",base:"/remote/work",on:"box"}]);
  expect(h.view.root).toBe("/remote/资料");expect(h.view.pathInput.value()).toBe("/remote/资料");
  h.switchFolder();h.nodes();await h.flush();expect(h.view.root).toBe("/remote/资料");
  h.view.pathInput.set_value("missing");h.click("files-path-open");await h.flush();
  expect(h.view.pathError).toContain("No such directory");expect(h.view.root).toBe("/remote/资料");
  h.switchScope("box","second");h.nodes();await h.flush();expect(h.view.root).toBe("/other/project");
  h.switchScope("box","space");h.nodes();await h.flush();expect(h.view.root).toBe("/remote/资料");
  h.click("files-path-follow");await h.flush();expect(h.view.root).toBe("/other/project");
  expect(h.view.pathInput.value()).toBe("/other/project");
  expect(h.nodes().some(n=>n.methods?.get("id")?.[0]==="files-path-follow")).toBe(false);
});

test("Files discards pending navigation after workspace switches or input edits", async () => {
  for(const change of ["scope","input"]) {
    const h=previewHarness(async()=>"");await h.flush();
    let finish!:(r:any)=>void;
    h.setExec(async(_command:string,args:string[])=>args[2]==="files-path"?new Promise(resolve=>{finish=resolve;}):{code:1});
    h.view.pathInput.set_value("/target");h.click("files-path-open");
    if(change==="scope") {h.switchScope("other-machine","other-space");h.nodes();}
    else {h.view.pathInput.set_value("/edited");h.view.pathInput.handlers.get("change")({},h.cx);}
    finish({code:0,stdout:"/target\n"});
    await h.flush();
    expect(h.view.roots.size).toBe(0);expect(h.view.navigation).toBeNull();
  }
  const panel=previewHarness(async()=>"# Fixed",{path:"/work/file.md",on:"box"});await panel.flush();
  expect(panel.nodes().some(n=>n.methods?.get("id")?.[0]==="files-path-input")).toBe(false);
});
