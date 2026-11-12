import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, home, appHome, exec, settings, pickFolder, closeOverlay, notify, theme, window } from "herdr";

const finished = state => state?.phase === "complete" || state?.phase === "error";
const bytes = n => n == null ? "…" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export default class FileDownload extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.source = { path:p.path, on:p.on ?? null, directory:p.directory === true };
    this.overlay = p.overlay;
    this.destination = `${home()}/Downloads`;
    cx.timer.every(1000, cx => this.poll(cx));
  }

  async call(op, value) {
    const r = await exec("python3", [`${appHome()}/mods/file-download/download.py`, op, appHome(), typeof value === "string" ? value : JSON.stringify(value)], { timeout:10000 });
    let state;
    try { state = JSON.parse(r.stdout); } catch { throw Error(r.stderr || "下载助手未返回结果"); }
    if (r.code !== 0 || state.error && !state.phase) throw Error(state.error || r.stderr || "下载助手不可用");
    return state;
  }

  choose(cx) {
    if (this.busy || this.state || this.picking) return;
    this.picking = true;
    cx.spawn(async cx => {
      try { const path = await pickFolder({prompt:"下载到此文件夹"}); if (path) this.destination = path; }
      catch (e) { this.error = String(e); }
      finally { this.picking = false; cx.notify(); }
    });
  }

  start(cx) {
    if (this.busy || this.state || this.picking || !this.source.path) return;
    this.busy = true; this.error = null; cx.notify();
    // All source fields were captured by the right-click, independent of focus.
    const request = { ...this.source, destination:this.destination, core:settings()?.core || "hc" };
    cx.spawn(async cx => {
      try { this.state = await this.call("start", request); }
      catch (e) { this.error = String(e); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  poll(cx) {
    if (this.busy || !this.state?.id || finished(this.state)) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        this.state = await this.call("status", this.state.id); this.error = null;
        if (finished(this.state)) notify({ title:this.state.phase === "complete" ? "下载完成" : "下载失败", body:this.state.path || this.state.error, level:this.state.phase === "complete" ? "success" : "error", timeout:8000 });
      } catch (e) { this.error = `读取进度失败（下载任务仍可能运行）：${e}`; }
      finally { this.busy = false; cx.notify(); }
    });
  }

  reveal(cx) {
    const path = this.state?.path;
    if (!path) return;
    const platform = window()?.platform;
    const command = platform === "macos" ? "open" : platform === "windows" ? "explorer.exe" : "xdg-open";
    const args = platform === "macos" ? ["-R", path] : [this.destination];
    cx.spawn(async cx => {
      try { const r = await exec(command, args); if (r.code !== 0) this.error = r.stderr || "无法打开保存位置"; }
      catch (e) { this.error = String(e); }
      cx.notify();
    });
  }

  render() {
    const t = theme(), s = this.state;
    const progress = s?.phase === "complete" ? "下载完成" : s?.phase === "finishing" ? "正在完成下载…" : s?.phase === "packing" ? "正在打包文件夹…" : s?.phase === "downloading"
      ? `正在下载 ${bytes(s.bytes)} / ${bytes(s.total)}${s.total ? ` · ${Math.min(99, Math.floor(s.bytes * 100 / s.total))}%` : ""}`
      : s ? "正在准备下载…" : "文件保存到本机；重名时自动添加编号。";
    const button = (id, label, action) => div().id(id).px(12).py(7).rounded(6).cursor_pointer().bg(t.hover).on_click(action).child(label);
    return v_flex().id("file-download").w_full().min_h(0).p(18).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
      .child(div().font_semibold().text_size(16).child(this.source.directory ? "下载文件夹（.tar.gz）" : "下载文件"))
      .child(div().text_color(t.muted).child(`来源：${this.source.on || "本机"}`))
      .child(div().text_size(12).truncate().tooltip(this.source.path || "").child(this.source.path || "未选择文件"))
      .child(div().text_color(t.muted).child("本机保存目录"))
      .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().tooltip(this.destination).child(this.destination))
        .when(!s && !this.busy, el => el.child(button("download-choose", this.picking ? "选择中…" : "选择目录", (_e, cx) => this.choose(cx)))))
      .child(div().text_color(s?.phase === "error" ? t.blocked : t.muted).child(s?.error || progress))
      .when(Boolean(s?.path), el => el.child(div().text_size(12).truncate().tooltip(s.path).child(s.path)))
      .when(Boolean(this.error || s?.cleanupWarning), el => el.child(div().text_size(12).text_color(t.blocked).child(this.error || s.cleanupWarning)))
      .child(h_flex().gap(8).justify_end()
        .when(!s, el => el.child(button("download-start", this.busy ? "正在启动…" : "开始下载", (_e, cx) => this.start(cx))))
        .when(s?.phase === "complete", el => el.child(button("download-reveal", "打开保存位置", (_e, cx) => this.reveal(cx))))
        .child(button("download-close", s && !finished(s) ? "关闭（下载继续）" : "关闭", () => closeOverlay(this.overlay))));
  }
}
