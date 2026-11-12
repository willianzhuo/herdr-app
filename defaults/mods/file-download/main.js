import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, home, appHome, exec, settings, pickFolder, closeOverlay, openOverlay, shared, setShared, notify, theme, window } from "herdr";

const finished = state => state?.phase === "complete" || state?.phase === "error";
const bytes = n => n == null ? "…" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const detailKey = id => `file-download.detail.${id}`;
const HIDDEN = "file-download.progress-hidden";
const detailVisible = id => { const value = shared(detailKey(id)); return value && Date.now() - value.at < 5000; };
const progress = s => s?.phase === "error" ? "下载失败" : s?.phase === "complete" ? "下载完成" : s?.phase === "finishing" ? "正在完成下载…" : s?.phase === "connecting" ? "正在连接 SFTP…" : s?.phase === "verifying" ? "正在校验下载…" : s?.phase === "packing" ? "正在打包文件夹…" : s?.phase === "downloading"
  ? `正在下载 ${bytes(s.bytes)} / ${bytes(s.total)}${s.total ? ` · ${Math.min(99, Math.floor(s.bytes * 100 / s.total))}%` : ""}`
  : s ? "正在准备下载…" : "文件保存到本机；重名时自动添加编号。";

export default class FileDownload extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.overlay = p.overlay;
    this.historyView = p.role === "history";
    this.progressView = p.role === "progress" || this.historyView;
    if (this.progressView) {
      this.jobs = [];
      this.monitorStarted = Date.now() / 1000;
      cx.timer.every(1000, cx => this.poll(cx));
      this.poll(cx);
      return;
    }
    this.source = { path:p.path, on:p.on ?? null, directory:p.directory === true };
    this.destination = p.destination || `${home()}/Downloads`;
    this.compatibility = false;
    cx.timer.every(1000, cx => this.poll(cx));
    if (p.job) {
      this.resuming = true;
      this.state = { id:p.job, phase:"queued", bytes:0, total:null };
      this.poll(cx);
    }
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
    const request = { ...this.source, destination:this.destination, core:settings()?.core || "hc", transport:this.compatibility ? "core" : "auto" };
    cx.spawn(async cx => {
      try { this.state = await this.call("start", request); setShared(HIDDEN, false); this.keepDetail(); }
      catch (e) { this.error = String(e); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  poll(cx) {
    if (this.progressView) return this.pollJobs(cx);
    this.keepDetail();
    if (this.busy || !this.state?.id || finished(this.state)) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        this.state = await this.call("status", this.state.id); this.error = null;
        if (finished(this.state) && !this.resuming) this.announce(this.state);
        this.resuming = false;
      } catch (e) { this.error = `读取进度失败（下载任务仍可能运行）：${e}`; }
      finally { this.busy = false; cx.notify(); }
    });
  }

  keepDetail() {
    if (!this.closed && this.state?.id && this.overlay) setShared(detailKey(this.state.id), { overlay:this.overlay, at:Date.now() });
  }

  announce(state) {
    const key = `file-download.notified.${state.id}`;
    if (shared(key)) return;
    setShared(key, true);
    notify({ title:state.phase === "complete" ? "下载完成" : "下载失败", body:state.path || state.error, level:state.phase === "complete" ? "success" : "error", timeout:8000 });
  }

  close() {
    this.closed = true;
    if (this.state?.id && shared(detailKey(this.state.id))?.overlay === this.overlay) setShared(detailKey(this.state.id), null);
  }

  pollJobs(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        const result = await this.call("list", "");
        if (!Array.isArray(result.jobs)) throw Error("下载列表不可用");
        const previous = new Map(this.jobs.map(job => [job.id, job]));
        if (!this.historyView) for (const job of result.jobs) {
          if (finished(job) && !detailVisible(job.id) &&
            (previous.has(job.id) ? !finished(previous.get(job.id)) : job.updated >= this.monitorStarted)) this.announce(job);
        }
        if (result.jobs.some(job => !previous.has(job.id) && !finished(job))) this.collapsed = false;
        this.jobs = result.jobs; this.error = null;
      }
      catch (e) { this.error = `读取下载进度失败：${e}`; }
      finally { this.busy = false; cx.notify(); }
    });
  }

  openJob(job) {
    if (detailVisible(job.id)) return;
    const overlay = openOverlay({ mod:"file-download", kind:"dialog", width:520, props:{ ...job.source, destination:job.destination, job:job.id } });
    setShared(detailKey(job.id), { overlay, at:Date.now() });
  }

  dismiss(job, cx) {
    cx.spawn(async cx => {
      try { await this.call("dismiss", job.id); this.jobs = this.jobs.filter(j => j.id !== job.id); }
      catch (e) { this.error = String(e); }
      cx.notify();
    });
  }

  dismissFinished(cx) {
    if (this.cleaning) return;
    const jobs = this.jobs.filter(finished);
    this.cleaning = true;
    cx.spawn(async cx => {
      try {
        for (const job of jobs) {
          await this.call("dismiss", job.id);
          this.jobs = this.jobs.filter(j => j.id !== job.id);
        }
      } catch (e) { this.error = String(e); }
      finally { this.cleaning = false; cx.notify(); }
    });
  }

  hideProgress() {
    if (this.historyView) closeOverlay(this.overlay);
    else setShared(HIDDEN, true);
  }

  renderProgress() {
    const jobs = this.historyView ? this.jobs : this.jobs.filter(job => !detailVisible(job.id));
    if (!this.historyView && (shared(HIDDEN) || !jobs.length && !this.error)) return div();
    const t = theme();
    const button = (id, label, action) => div().id(id).px(7).py(4).rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    return v_flex().id("download-progress").w(340).p(10).gap(6).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_semibold().child(`下载${jobs.length ? ` · ${jobs.length}` : ""}`))
        .when(this.jobs.some(finished), el => el.child(button("downloads-clear", this.cleaning ? "清除中…" : "清除已结束", (_e, cx) => this.dismissFinished(cx))))
        .when(!this.historyView, el => el.child(button("downloads-collapse", this.collapsed ? "展开" : "收起", (_e, cx) => { this.collapsed = !this.collapsed; cx.notify(); })))
        .child(button("downloads-close", "×", () => this.hideProgress()).tooltip(this.historyView ? "关闭" : "关闭进度窗口；下载继续，可从 Files → 下载查看")))
      .when(this.historyView && !jobs.length, el => el.child(div().py(12).text_color(t.muted).child("暂无下载任务")))
      .when(this.historyView || !this.collapsed, el => el.child(v_flex().id("download-progress-list").max_h(300).overflow_y_scroll().gap(6).children(jobs.map(job => {
        const name = (job.source.path || "文件").split(/[\\/]/).filter(Boolean).pop() || "文件";
        const percent = job.phase === "complete" ? 100 : job.total > 0 ? Math.min(99, Math.floor(job.bytes * 100 / job.total)) : 0;
        return v_flex().id(`download-job-${job.id}`).p(8).gap(5).rounded(6).bg(t.background)
          .child(h_flex().items_center().gap(5)
            .child(div().id(`download-open-${job.id}`).flex_1().min_w(0).truncate().tooltip(job.source.path).cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.openJob(job)).child(`${job.source.on || "本机"} · ${name}`))
            .when(finished(job), el => el.child(button(`download-dismiss-${job.id}`, "×", (_e, cx) => this.dismiss(job, cx)))))
          .child(div().id(`download-status-${job.id}`).cursor_pointer().text_color(job.phase === "error" ? t.blocked : t.muted)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.openJob(job)).child(progress(job)))
          .when(job.phase !== "error", el => el.child(div().h(3).w_full().rounded(2).bg(t.border).overflow_hidden()
            .child(div().h(3).w(percent * 3.04).bg(job.phase === "complete" ? t.done : t.accent))))
          .when(job.phase === "complete", el => el.child(button(`download-reveal-${job.id}`, "打开保存位置", (_e, cx) => this.reveal(cx, job.path, job.destination))));
      }))))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)));
  }

  reveal(cx, path = this.state?.path, destination = this.destination) {
    if (!path) return;
    const platform = window()?.platform;
    const command = platform === "macos" ? "open" : platform === "windows" ? "explorer.exe" : "xdg-open";
    const args = platform === "macos" ? ["-R", path] : [destination];
    cx.spawn(async cx => {
      try { const r = await exec(command, args); if (r.code !== 0) this.error = r.stderr || "无法打开保存位置"; }
      catch (e) { this.error = String(e); }
      cx.notify();
    });
  }

  render() {
    if (this.progressView) return this.renderProgress();
    const t = theme(), s = this.state;
    const button = (id, label, action) => div().id(id).px(12).py(7).rounded(6).cursor_pointer().bg(t.hover).on_click(action).child(label);
    return v_flex().id("file-download").w_full().min_h(0).p(18).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
      .child(div().font_semibold().text_size(16).child(this.source.directory ? "下载文件夹（.tar.gz）" : "下载文件"))
      .child(div().text_color(t.muted).child(`来源：${this.source.on || "本机"}`))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_color(t.muted).child(`传输：${s?.transport === "SFTP" ? "SFTP" : s?.transport === "Core" ? "Core 兼容模式" : s?.transport === "Local" ? "本机复制" : this.compatibility ? "Core 兼容模式" : "SFTP 优先"}${s?.transportDetail ? ` · ${s.transportDetail}` : ""}`))
        .when(!s && !this.busy, el => el.child(button("download-transport", this.compatibility ? "使用 SFTP" : "兼容模式", (_e, cx) => { this.compatibility = !this.compatibility; cx.notify(); }))))
      .child(div().text_size(12).truncate().tooltip(this.source.path || "").child(this.source.path || "未选择文件"))
      .child(div().text_color(t.muted).child("本机保存目录"))
      .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().tooltip(this.destination).child(this.destination))
        .when(!s && !this.busy, el => el.child(button("download-choose", this.picking ? "选择中…" : "选择目录", (_e, cx) => this.choose(cx)))))
      .child(div().text_color(s?.phase === "error" ? t.blocked : t.muted).child(s?.error || progress(s)))
      .when(Boolean(s?.path), el => el.child(div().text_size(12).truncate().tooltip(s.path).child(s.path)))
      .when(Boolean(this.error || s?.cleanupWarning), el => el.child(div().text_size(12).text_color(t.blocked).child(this.error || s.cleanupWarning)))
      .child(h_flex().gap(8).justify_end()
        .when(!s, el => el.child(button("download-start", this.busy ? "正在启动…" : "开始下载", (_e, cx) => this.start(cx))))
        .when(s?.phase === "complete", el => el.child(button("download-reveal", "打开保存位置", (_e, cx) => this.reveal(cx))))
        .child(button("download-close", s && !finished(s) ? "关闭（下载继续）" : "关闭", () => closeOverlay(this.overlay))));
  }
}
