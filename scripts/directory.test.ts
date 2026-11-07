import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../personal-config/directory.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replaceAll("export function", "function");

function harness(failure = false) {
  let focus = { space: "space-a", cwd: "/project/current" };
  const spaces = [{ id: "space-a", machine: "box", folder: "/project", active: true }];
  const calls: any[] = [], notifications: any[] = [], execs: any[] = [];
  let release: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  const api = new Function("nativeRun", "spaces", "focused", "appHome", "readTextFile", "notify", "exec", `${source}; return {run};`)(
    (...args: any[]) => calls.push(args), () => spaces, () => focus, () => "/app",
    async (path: string) => path.endsWith(".json") ? JSON.stringify({box:"/default/work"}) : "installer source",
    (n: any) => notifications.push(n),
    async (...args: any[]) => { execs.push(args); await wait; return failure ? {code:1, stderr:"setup failed"} : {code:0, stdout:'{"status":"unchanged"}'}; },
  );
  return { ...api, calls, notifications, execs,
    switchFocus: () => { focus = {space:"other",cwd:"/wrong"}; },
    pause: () => { wait = new Promise<void>(resolve => { release = resolve; }); },
    release: () => release?.(),
  };
}

test("default workspace and inherited/explicit tab directories survive guard installation", async () => {
  const h = harness();
  await h.run("space.new", {});
  expect(h.calls[0][1]).toEqual({machine:"box",folder:"/default/work"});
  await h.run("tab.new", {});
  expect(h.calls[1][1]).toEqual({space:"space-a",folder:"/project/current"});
  await h.run("tab.new", {folder:"/explicit ' project"});
  expect(h.calls[2][1].folder).toBe("/explicit ' project");
  expect(h.execs).toHaveLength(3);
  expect(h.execs[0]).toEqual(["python3",["-c","installer source"],{on:"box",timeout:15000}]);
  expect(h.notifications).toEqual([]);
});

test("concurrent requests share setup and retain the captured target across focus switches", async () => {
  const h = harness(); h.pause();
  const first = h.run("tab.new", {}), second = h.run("space.new", {});
  await new Promise(resolve => setTimeout(resolve, 0));
  h.switchFocus(); h.release();
  await Promise.all([first, second]);
  expect(h.execs).toHaveLength(1);
  expect(h.calls[0][1].space).toBe("space-a");
  expect(h.calls[1][1].machine).toBe("box");
});

test("mod tabs and local explicit workspaces need no remote shell changes", async () => {
  const h = harness();
  await h.run("tab.new", {mod:"files"});
  await h.run("space.new", {machine:"",folder:"/local"});
  expect(h.execs).toHaveLength(0);
  expect(h.calls).toHaveLength(2);
});

test("explicit workspace folders remain literal and a failed preparation does not spawn in a wrong directory", async () => {
  const h = harness();
  await h.run("space.new", {machine:"box",folder:"/specific ' checkout"});
  expect(h.calls[0][1].folder).toBe("/specific ' checkout");
  const failed = harness(true);
  await failed.run("space.new", {});
  expect(failed.calls).toHaveLength(0);
  expect(failed.notifications).toHaveLength(1);
  expect(failed.notifications[0].body).toContain("setup failed");
});
