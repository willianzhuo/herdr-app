import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionTitle, SESSION_KEY } from "../defaults/mods/agents/session-titles.js";

for (const file of ["defaults/mods/tabs/main.js", "personal-config/tabs-copy-main.js"]) {
  const source = (await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs");
  const storage = new Map<string, string>();
  let cache: any = null;
  const { Tabs, title } = new Function("View", "localStorage", "sessionTitle", "SESSION_KEY", "shared", `${source}; return { Tabs, title: tabTitle };`)(class {}, {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  }, sessionTitle, SESSION_KEY, () => cache);
  const pane = (tab: string, id: string, focused = false) => ({
    tab, pane: id, focused, terminal: id, title: `${id} session`, program: { name: "Codex", key: "codex" },
  });
  test(`${file}: focus survives tab switches/reload and falls back after pane moves`, () => {
    storage.clear();
    const view = new Tabs();
    const all = [pane("a", "a1"), pane("a", "a2", true), pane("b", "b1")];
    expect(view.titlePanels(all)("a").pane).toBe("a2");
    all[1].focused = false; all[2].focused = true;
    expect(view.titlePanels(all)("a").pane).toBe("a2");
    expect(new Tabs().titlePanels(all)("a").pane).toBe("a2");
    all[1].tab = "b";
    expect(view.titlePanels(all)("a").pane).toBe("a1");
    expect(JSON.parse(storage.get("title-focus")!)).not.toHaveProperty("a");
    all.splice(1, 1);
    expect(view.titlePanels(all)("b").pane).toBe("b1");
    expect(JSON.parse(storage.get("title-focus")!)).not.toHaveProperty("a");
  });
  test(`${file}: each focused panel supplies its own title, with manual names preserved`, () => {
    cache = null;
    const all = [pane("a", "first"), pane("a", "second")];
    const tab = { id: "a", name: "1", named: false };
    expect(title(tab, all[1], all, {})).toBe("second session");
    expect(title(tab, all[1], all, { report: { title: "Actual session" } })).toBe("Actual session");
    expect(title({ ...tab, name: "Pinned task", named: true }, all[1], all, {})).toBe("Pinned task");
    expect(title({ ...tab, name: "Codex", named: true }, all[1], all, {})).toBe("second session");
    expect(title(tab, { ...all[1], title: "Files", terminal: null }, all, {})).toBe("Files");
    expect(title(tab, { ...all[1], title: "[ ! ] Action Required | Own session", program: { key: "traex" } }, all, {})).toBe("Own session");
  });
  test(`${file}: focused Traex panel resolves its own real session instead of its cwd title`, () => {
    const records:any[] = [1,2].map(i => ({ address:`200/t${i}`, state:"live", program:{key:"traex"}, created_ms:123, foreground:{pid:i} }));
    cache = Object.fromEntries(records.map((t,i)=>[t.address,{pid:i+1,created:123,name:`Session ${i+1}`,at:Date.now()}]));
    const all=records.map((t,i)=>({tab:"a",pane:`p${i}`,terminal:t.address,title:"work",program:t.program,focused:i===0}));
    const tab={id:"a",name:"1",named:false}, view=new Tabs();
    let p=view.titlePanels(all)("a");
    expect(title(tab,p,all,records.find(t=>t.address===p.terminal))).toBe("Session 1");
    all[0].focused=false;all[1].focused=true;
    p=view.titlePanels(all)("a");
    expect(title(tab,p,all,records.find(t=>t.address===p.terminal))).toBe("Session 2");
    cache=null;
  });

}
