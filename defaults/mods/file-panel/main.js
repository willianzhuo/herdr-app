// A file owns its path/machine, rather than following the focused terminal.
import { div } from "gpui-kit";
import { props } from "herdr";
import Files from "./files.js";

export default class FilePanel extends Files {
  init(_props, cx) {
    this.detached = true;
    this.refresh(cx);
    cx.timer.every(10000, cx => { this.refresh(cx); this.loadFile(cx); });
  }

  current(context) { return this.context === context && this.fileKey() === context.key; }

  fileKey() { const p = props() ?? {}; return JSON.stringify([p.path, p.on ?? null]); }

  refresh(cx) {
    const p = props() ?? {}, key = this.fileKey();
    if (this.context?.key === key) return;
    const path = typeof p.path === "string" ? p.path : "";
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
    const split = windows ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/");
    this.invalid = !path || split < 0 || split === path.length - 1;
    this.context = {key};
    if (this.invalid) { this.show(null); return; }
    this.root = path.slice(0, split) || "/";
    this.on = p.on ?? null;
    this.show(path.slice(split + 1), cx);
  }

  render(cx) {
    this.refresh(cx);
    return this.invalid ? div().p(12).child("No file selected") : super.render(cx);
  }
}
