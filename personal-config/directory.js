import { run as nativeRun, spaces, focused, appHome, readTextFile, notify } from "herdr";

// Capture the target before reading the file: switching tabs while it loads must
// not accidentally create a terminal on a different machine.
export function resolveTarget(command, args, allSpaces, focus) {
  const active = allSpaces.find(s => s.id === focus?.space) ?? allSpaces.find(s => s.active);
  const target = args.space != null ? allSpaces.find(s => s.id === args.space) : active;
  if (args.space != null && !target) throw new Error("目标工作区已关闭，请重新选择。");
  const result = { ...args };
  let machine = target?.machine ?? "";
  if (command === "space.new") {
    machine = args.machine ?? machine;
    result.machine = machine;
  } else if (target) {
    result.space = target.id;
    // New tabs follow the focused terminal, with the workspace folder as fallback.
    if (result.folder == null) result.folder = (target.id === focus?.space && focus?.cwd) || target.folder || undefined;
  } else {
    command = "space.new";
    result.machine = "";
  }
  return { command, args: result, machine };
}

export function applyDirectory(text, target, explicitFolder) {
  const map = text == null ? {} : JSON.parse(text);
  if (!map || Array.isArray(map) || typeof map !== "object") throw new Error("映射必须是 JSON 对象。");
  for (const [machine, folder] of Object.entries(map)) {
    if (folder !== null && (typeof folder !== "string" || !folder.trim()))
      throw new Error(`机器 ${machine || "本机"} 的目录必须是非空字符串或 null。`);
    if (typeof folder === "string" && !(/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(folder)))
      throw new Error(`机器 ${machine || "本机"} 请使用绝对路径。`);
  }
  const folder = Object.prototype.hasOwnProperty.call(map, target.machine) ? map[target.machine] : null;
  return { ...target, args: { ...target.args, ...(explicitFolder == null && folder != null ? { folder } : {}) } };
}

export function run(command, args = {}) {
  // Explicit directories (including worktrees) and non-terminal tabs retain
  // their requested destination. This custom action handles spaces and tabs.
  if (!(["space.new", "tab.new"].includes(command)) || args.mod || args.folder != null)
    return nativeRun(command, args);
  const target = resolveTarget(command, args, spaces(), focused());
  return launch(target);
}

async function launch(target) {
  try {
    // Existing workspaces keep the focused terminal's directory. Only a new
    // workspace uses the machine's configured default.
    if (target.command === "tab.new") {
      nativeRun(target.command, target.args);
      return;
    }
    const text = await readTextFile(`${appHome()}/machine-directories.json`);
    const request = applyDirectory(text, target);
    nativeRun(request.command, request.args);
  } catch (error) {
    notify({ title: "无法按默认目录新建", body: `检查 machine-directories.json：${String(error)}`, level: "error" });
  }
}
