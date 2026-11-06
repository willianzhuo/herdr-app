import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../defaults/mods/agents/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class Agents", "class Agents");

function harness(pins: string[], globals: Record<string, unknown> = {}) {
  const data = new Map([["pins", JSON.stringify(pins)]]);
  const writes: unknown[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) };
  const tasks: Promise<unknown>[] = [];
  globals = { knownAgents: async () => [], spaces: () => [], ...globals };
  const Agents = new Function("View", "localStorage", "props", "run", ...Object.keys(globals), `${source}; return Agents;`)(
    class {}, storage, () => ({}), (...args: unknown[]) => writes.push(args),
    ...Object.values(globals),
  );
  const agents = new Agents();
  agents.init({}, { timer: { every() {} }, spawn(fn: any) { tasks.push(fn({ notify() {} })); } });
  return { agents, data, writes, tasks };
}

test("legacy pins migrate once listed, retaining offline pins until their labels arrive", () => {
  const { agents, data, writes } = harness(["t1", "offline/t2"]);
  agents.migratePins([]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  const local = { address: "t1", state: "live", labels: {} };
  agents.migratePins([local]);
  agents.migratePins([local]);
  expect(writes).toEqual([["terminal.pin", { terminal: "t1", pinned: true }]]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  agents.migratePins([{ ...local, labels: { "herdr.pinned": "1" } }]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["offline/t2"]);
  const remote = { address: "offline/t2", state: "live", labels: {} };
  agents.migratePins([remote]);
  expect(writes).toHaveLength(2);
  agents.migratePins([{ ...remote, labels: { "herdr.pinned": "1" } }]);
  expect(data.has("pins")).toBe(false);
});

test("already shared pins need no write and pending writes survive restart", () => {
  expect(harness([]).data.has("pins")).toBe(false);
  const { agents, data, writes } = harness(["t1"]);
  agents.migratePins([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
  expect(writes).toHaveLength(0);
  expect(data.has("pins")).toBe(false);
  const retry = harness(["t2"]);
  retry.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(JSON.parse(retry.data.get("pins")!)).toEqual(["t2"]);
  const restarted = harness(JSON.parse(retry.data.get("pins")!));
  restarted.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(restarted.writes).toHaveLength(1);
});

test("agent names come from their own session, never a tab label", () => {
  const title = new Function("View", `${source}; return agentTitle;`)(class {});
  const agent = { address: "200/t2", title: "Own terminal title", program: { name: "Codex" } };
  expect(title(agent, { title: "Own panel title" }, { report: { title: "Own session" } })).toBe("Own session");
  expect(title(agent, { title: "Own panel title" }, {})).toBe("Own panel title");
  expect(title(agent, null, {})).toBe("Own terminal title");
  expect(title({ ...agent, title: "" }, null, {})).toBe("Codex");
  expect(title({ ...agent, title: "[ ! ] Action Required | Own session", program: { key: "traex" } }, null, {})).toBe("Own session");
});

test("clearing an agent report preserves presence and a new session report replaces the fallback", () => {
  const include = new Function("View", `${source}; return includeUnreportedAgents;`)(class {});
  const program = { key: "claude", name: "Claude Code", agent: false };
  const terminal = { address: "remote/t1", state: "live", program, reported: true, status: null, labels: {} };
  const panel = { pane: "p1", terminal: terminal.address, tab: "tab", title: "Session one", program };
  const spaces = [{ id: "space", name: "Project", tabs: [{ id: "tab", name: "1" }] }];
  const keys = new Set(["claude"]);
  let rows = include([], [terminal], [panel], spaces, keys);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ address: "remote/t1", pane: "p1", status: "unknown", title: "Session one" });
  const resumed = { ...rows[0], status: "working", title: "Session two" };
  rows = include([resumed], [terminal], [panel], spaces, keys);
  expect(rows).toEqual([resumed]);
  expect(include([], [{ ...terminal, state: "finished" }], [panel], spaces, keys)).toEqual([]);
  // Historical reported=true must not turn the shell or editor into the old agent.
  for (const key of ["shell", "nvim"]) {
    expect(include([], [{ ...terminal, program: { key } }], [panel], spaces, keys)).toEqual([]);
  }
});

test("unreported agents use full remote addresses and deduplicate repeated panes", () => {
  const include = new Function("View", `${source}; return includeUnreportedAgents;`)(class {});
  const program = { key: "traex" };
  const all = ["t1", "remote/t1"].map(address => ({ address, state: "live", program, labels: {} }));
  const panels = all.map((t, i) => ({ pane: `p${i}`, terminal: t.address, tab: "tab", title: t.address }));
  const workspaces = [{ id: "space", name: "Project", tabs: [{ id: "tab" }] }];
  expect(include([], all, [...panels, panels[0]], workspaces, new Set(["traex"])).map((a: any) => a.address)).toEqual(["t1", "remote/t1"]);
});

test("reported and unreported agents merge in pane order so a workspace remains contiguous", () => {
  const include = new Function("View", `${source}; return includeUnreportedAgents;`)(class {});
  const program = { key: "claude" };
  const panels = [
    { pane: "a1", terminal: "remote/t1", tab: "a" },
    { pane: "a2", terminal: "remote/t2", tab: "a" },
    { pane: "b1", terminal: "remote/t3", tab: "b" },
  ].map(p => ({ ...p, program }));
  const all = panels.map(p => ({ address: p.terminal, state: "live", program }));
  const spaces = [{ id: "A", name: "Project A", tabs: [{ id: "a" }] }, { id: "B", name: "Project B", tabs: [{ id: "b" }] }];
  const reported = [
    { address: "remote/t1", space: "A", tab: "a", status: "idle" },
    { address: "remote/t3", space: "B", tab: "b", status: "idle" },
  ];
  const rows = include(reported, all, panels, spaces, new Set(["claude"]));
  expect(rows.map((a: any) => a.address)).toEqual(["remote/t1", "remote/t2", "remote/t3"]);
  expect(rows.map((a: any) => a.space)).toEqual(["A", "A", "B"]);
  expect(reported.map(a => a.address)).toEqual(["remote/t1", "remote/t3"]);
});

// Lightweight element descriptions: execute conditional builders and retain text,
// without running input callbacks or pretending to exercise native GPUI layout.
function element() {
  const node = { id: "", children: [] as any[] };
  const el: any = new Proxy(node, { get: (_, method) => {
    if (method === "node") return node;
    return (...args: any[]) => {
      if (method === "id") node.id = args[0];
      if (method === "on_click") (node as any).click = args[0];
      if (method === "child") node.children.push(args[0]?.node ?? args[0]);
      if (method === "children") node.children.push(...args[0].map((child: any) => child?.node ?? child));
      if (method === "when" && args[0]) args[1](el);
      return el;
    };
  } });
  return el;
}
function textOf(node: any): string {
  return typeof node === "string" ? node : (node?.children ?? []).map(textOf).join(" ");
}

test("grouped rendering gives one workspace header for mixed reported and unreported sessions", async () => {
  const program = { key: "claude", name: "Claude Code" };
  const panels = [
    { pane: "a1", terminal: "remote/t1", tab: "a", title: "First session" },
    { pane: "a2", terminal: "remote/t2", tab: "a", title: "Unreported session" },
    { pane: "b1", terminal: "remote/t3", tab: "b", title: "Other workspace" },
  ].map(p => ({ ...p, program }));
  const workspaces = [{ id: "A", name: "Project A", tabs: [{ id: "a" }] }, { id: "B", name: "Project B", tabs: [{ id: "b" }] }];
  const { agents, tasks } = harness([], {
    knownAgents: async () => [{ key: "claude" }],
    agents: () => [
      { address: "remote/t1", pane: "a1", tab: "a", space: "A", space_name: "Project A", status: "idle", program },
      { address: "remote/t3", pane: "b1", tab: "b", space: "B", space_name: "Project B", status: "idle", program },
    ],
    terminals: () => panels.map(p => ({ address: p.terminal, state: "live", program })),
    panes: () => panels, spaces: () => workspaces, focused: () => null,
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => "grouped",
    theme: () => ({}), setAgentOrder: () => {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  await Promise.all(tasks);
  const ids: string[] = [];
  const walk = (node: any) => { if (node?.id) ids.push(node.id); (node?.children ?? []).forEach(walk); };
  walk(agents.render({}).node);
  expect(ids.filter(id => id === "sp-A")).toHaveLength(1);
  expect(ids.filter(id => id === "sp-B")).toHaveLength(1);
  expect(ids.filter(id => id.startsWith("ag-remote/"))).toEqual(["ag-remote/t1", "ag-remote/t2", "ag-remote/t3"]);
});

for (const sort of ["priority", "grouped"]) test(`${sort}: unreported running Claude remains visible without being labelled idle or done`, async () => {
  const program = { key: "claude", name: "Claude Code", agent: false };
  const panel = { pane: "p1", terminal: "remote/t1", tab: "tab1", title: "Resumed session", program };
  const { agents, tasks } = harness([], {
    knownAgents: async () => [{ ...program, installed: false }],
    agents: () => [], terminals: () => [{ address: panel.terminal, state: "live", program, status: null, labels: {} }],
    panes: () => [panel], focused: () => null,
    spaces: () => [{ id: "s1", name: "Project", tabs: [{ id: "tab1", name: "1" }] }],
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => sort,
    theme: () => ({}), setAgentOrder: () => {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  await Promise.all(tasks);
  const text = textOf(agents.render({}).node);
  expect(text).toContain("Resumed session");
  expect(text).toContain("?");
  if (sort === "priority") expect(text).toContain("Status unknown");
  expect(text).not.toContain("Idle");
  expect(text).not.toContain("Done");
});

for (const sort of ["priority", "grouped"]) test(`${sort} render reads panes once and refreshes labels on the next render`, () => {
  const list = Array.from({ length: 64 }, (_, i) => ({
    address: `t${i}`, pane: `p${i}`, tab: "same-tab", space: "s1", space_name: "Project",
    program: { name: "Claude", key: "claude", agent: true }, title: "Fallback", status: "idle", seq: i,
  }));
  const snapshot = list.map((a, i) => ({ tab: a.tab, terminal: a.address, program: a.program, title: `Task ${i}` }));
  let reads = 0;
  const orders: string[][] = [];
  const { agents } = harness([], {
    agents: () => list, terminals: () => list.map(a => ({ ...a, state: "live" })),
    panes: () => { reads++; return structuredClone(snapshot); }, focused: () => null,
    spaces: () => [{ tabs: list.map(a => ({ id: a.tab, name: "Claude", named: true })) }],
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => sort,
    theme: () => ({}), setAgentOrder: (order: string[]) => orders.push(order),
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const first = textOf(agents.render({}).node);
  expect(reads).toBe(1);
  for (let i = 0; i < list.length; i++) expect(first).toContain(`Task ${i}`);
  expect(orders[0]).toHaveLength(list.length);
  snapshot[63].title = "Updated task";
  const second = textOf(agents.render({}).node);
  expect(reads).toBe(2);
  expect(second).toContain("Updated task");
  expect(second).not.toContain("Task 63");
  expect(orders[1]).toEqual(orders[0]);
});

// A kept sub-agent: started by t1 (`hc run`), then given a pane (`terminal.keep`).
function keptRender(sort: string, { width = 268, kept = [{ address: "t3", parent: "t1" }], paneless = [] as { address: string; parent: string }[], pinned = [] as string[] } = {}) {
  const program = { name: "Claude", key: "claude", agent: true };
  const row = (address: string, seq: number) => ({ address, pane: `p-${address}`, tab: "tab1", space: "s1", space_name: "Project", program, title: address, status: "working", seq, pinned: pinned.includes(address) });
  const list = [row("t1", 1), ...kept.map((k, i) => row(k.address, i + 2))];
  const live = (address: string, parent: string | null) => ({ address, parent, state: "live", status: "working", program, labels: {} });
  const orders: string[][] = [];
  const { agents, writes } = harness([], {
    agents: () => list,
    terminals: () => [live("t1", null), ...paneless.map(k => live(k.address, k.parent)), ...kept.map(k => live(k.address, k.parent))],
    panes: () => list.map(a => ({ tab: a.tab, terminal: a.address, program, title: a.title })), focused: () => null,
    spaces: () => [{ tabs: [{ id: "tab1", name: "Project", named: true }] }],
    layout: () => ({ id: "sidebar", size: { px: width } }), shared: () => sort,
    theme: () => ({}), setAgentOrder: (order: string[]) => orders.push(order),
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const ids: string[] = [];
  const clicks = new Map<string, () => void>();
  const walk = (node: any) => {
    if (node?.id) { ids.push(node.id); if (node.click) clicks.set(node.id, node.click); }
    (node?.children ?? []).forEach(walk);
  };
  walk(agents.render({}).node);
  return { ids, clicks, writes, order: orders[orders.length - 1] };
}

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent shows once, under its parent, and its row focuses its pane`, () => {
  const { ids, clicks, writes, order } = keptRender(sort);
  expect(ids).toContain("ag-t1");
  expect(ids).toContain("sub-t3");
  expect(ids).not.toContain("ag-t3");
  expect(order).toEqual(["t1"]);
  clicks.get("sub-t3")!();
  expect(writes).toContainEqual(["pane.focus", { terminal: "t3" }]);
});

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent under a pane-less one shows once in the tree`, () => {
  const { ids } = keptRender(sort, { paneless: [{ address: "t3", parent: "t1" }], kept: [{ address: "t4", parent: "t3" }] });
  expect(ids).toContain("sub-t3");
  expect(ids).toContain("sub-t4");
  expect(ids).not.toContain("ag-t4");
});

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent keeps its own row where no tree shows it`, () => {
  expect(keptRender(sort, { width: 44 }).ids).toContain("ag-t3"); // the rail draws no trees
  expect(keptRender(sort, { pinned: ["t3"] }).ids).toContain("ag-t3");
  expect(keptRender(sort, { kept: [{ address: "t3", parent: "t9" }] }).ids).toContain("ag-t3"); // its parent ended
});
