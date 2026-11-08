import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionTitle, SESSION_KEY } from "../defaults/mods/agents/session-titles.js";

import { ClaudeStatus, claudeSession, claudeTabStatus, CLAUDE_KEY } from "../defaults/mods/agents/claude-status.js";

import { PortsController } from "../defaults/mods/ports/controller.js";

for (const file of ["defaults/mods/tabs/main.js", "personal-config/tabs-copy-main.js"]) {
  const source = (await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs");
  const storage = new Map<string, string>();
  let cache: any = null;
  const { Tabs, title } = new Function("View", "localStorage", "claudeSession", "CLAUDE_KEY", "sessionTitle", "SESSION_KEY", "shared", `${source}; return { Tabs, title: tabTitle };`)(class {}, {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  }, claudeSession, CLAUDE_KEY, sessionTitle, SESSION_KEY, () => cache);
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

// Exercise the real settings click handlers and tab render paths together.
// Native `herdr-app check` additionally validates these fluent UI calls.
function widthHarness(source: string, settingsSource: string) {
  const preferences = new Map<string, unknown>();
  const storage = new Map<string, string>();
  type Element = { kind: string; calls: Map<string, unknown[]>; kids: unknown[] };
  const element = (kind: string): any => {
    const node: Element = { kind, calls: new Map(), kids: [] };
    const proxy: any = new Proxy(node, {
      get(target, key: string) {
        if (key in target) return target[key as keyof Element];
        return (...args: any[]) => {
          if (key === "when") return args[0] ? args[1](proxy) : proxy;
          if (key === "child") { if (args[0] != null) target.kids.push(args[0]); }
          else if (key === "children") target.kids.push(...args[0]);
          else target.calls.set(key, args);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const program = { key: "codex", name: "Codex", icon: "codex.svg", tint: true };
  const panels = [
    { pane: "p1", terminal: "t1", tab: "a", title: "Short", program, focused: true },
    { pane: "p2", terminal: "t2", tab: "a", title: "A much longer session title that fills the available space", program: { ...program, icon: null }, focused: false },
  ];
  const tabs = [
    { id: "a", name: "1", named: false, active: true, status: "idle" },
    { id: "b", name: "Other", named: true, active: false, status: "idle" },
  ];
  const globals = {
    View: class {}, div: () => element("div"), h_flex: () => element("row"), v_flex: () => element("column"),
    svg: () => element("svg"), image: () => element("image"),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    shared: (key: string) => preferences.get(key) ?? null,
    setShared: (key: string, value: unknown) => preferences.set(key, value),
    spaces: () => [{ id: "space", active: true, tabs }], panes: () => panels, terminals: () => [],
    settings: () => ({ zoom: 1 }), theme: () => ({}), layout: () => ({}), window: () => ({ platform: "macos" }),
    run: () => {}, openOverlay: () => {}, sessionTitle, SESSION_KEY, ClaudeStatus, claudeSession, claudeTabStatus, CLAUDE_KEY, PortsController, appHome:()=>"/tmp/herdr-ports-test", exec: async () => ({code:1}),
  };
  const load = (code: string, name: string) => new Function(...Object.keys(globals), `${code}; return ${name};`)(...Object.values(globals));
  const Tabs = load(source, "Tabs"), Settings = load(settingsSource, "Settings");
  const view = new Tabs(), settingsView = new Settings();
  const find = (node: any, id: string): any => {
    if (!node || typeof node !== "object") return null;
    if (node.calls.get("id")?.[0] === id) return node;
    for (const child of node.kids) {
      const result = find(child, id);
      if (result) return result;
    }
    return null;
  };
  const click = (id: string) => find(settingsView.tabWidthControl({}), id).calls.get("on_click")[0]();
  const render = () => find(view.render(), "tab-a");
  return { preferences, panels, tabs, find, click, render, Settings };
}

const settingsSource = (await readFile(new URL("../defaults/frame/settings/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class Settings", "class Settings");

for (const file of ["defaults/mods/tabs/main.js", "personal-config/tabs-copy-main.js"]) {
  const source = (await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace("export default class Tabs", "class Tabs");

  test(`${file}: settings changes take effect in tab rendering and respect width limits`, () => {
    const h = widthHarness(source, settingsSource);
    expect(h.render().calls.get("w")).toEqual([220]);
    h.click("st-tab-width-plus");
    expect(h.render().calls.get("w")).toEqual([240]);
    for (let i = 0; i < 20; i++) h.click("st-tab-width-plus");
    expect(h.render().calls.get("w")).toEqual([400]);
    for (let i = 0; i < 20; i++) h.click("st-tab-width-minus");
    expect(h.render().calls.get("w")).toEqual([160]);
    // Reopening the settings view reads the saved shared preference.
    expect(new h.Settings().tabWidthControl({}).kids[0].kids[1].kids).toContain("160 px");
    h.click("st-tab-width-reset");
    expect(h.preferences.get("tabs.width")).toBeNull();
    expect(h.render().calls.get("w")).toEqual([220]);
  });

  test(`${file}: fixed tabs keep their title space across pane focus, status and selection changes`, () => {
    const h = widthHarness(source, settingsSource);
    h.preferences.set("tabs.width", 240);
    const before = h.render();
    expect(before.kids[1].kids).toContain("Short");
    h.panels[0].focused = false;
    h.panels[1].focused = true;
    for (const active of [true, false]) {
      h.tabs[0].active = active;
      for (const status of ["idle", "working", "blocked", "done"]) {
        h.tabs[0].status = status;
        const tab = h.render();
        expect(tab.calls.get("w")).toEqual([240]);
        expect(tab.calls.get("min_w")).toEqual([240]);
        expect(tab.calls.get("max_w")).toEqual([240]);
        expect(tab.kids).toHaveLength(4);
        expect(tab.kids.map((node: any) => node.calls.get("size")?.[0])).toEqual([14, undefined, 12, 12]);
        expect(tab.kids[1].calls.has("max_w")).toBe(false);
        expect(tab.kids[1].calls.has("truncate")).toBe(true);
        expect(tab.kids[1].calls.get("tooltip")).toEqual([h.panels[1].title]);
        expect(tab.kids[1].kids).toContain(h.panels[1].title);
      }
    }
  });

  test(`${file}: malformed preferences retain the default width and numeric widths are bounded`, () => {
    const h = widthHarness(source, settingsSource);
    for (const value of [null, "240", false, {}, -1, 0, NaN, Infinity]) {
      h.preferences.set("tabs.width", value);
      expect(h.render().calls.get("w")).toEqual([220]);
    }
    for (const [value, width] of [[120, 160], [500, 400], [239.6, 240]]) {
      h.preferences.set("tabs.width", value);
      expect(h.render().calls.get("w")).toEqual([width]);
    }
  });
}
