// Clipboard actions own the paths captured when the folder was right-clicked.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";

export default class FilePathMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.items = [
      { id: "relative", label: "复制相对路径", path: props()?.relative },
      { id: "absolute", label: "复制绝对路径", path: props()?.absolute },
    ];
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(index, cx) {
    const item = this.items[index];
    if (typeof item?.path !== "string" || !item.path) return;
    cx.write_to_clipboard(item.path);
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    return v_flex().id("file-path-menu").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "up" || e.key === "down") this.at = 1 - this.at;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(this.items.map((item, index) => h_flex().id(`copy-path-${item.id}`).h(31).px(9).items_center().rounded(6)
        .text_color(item.path ? t.foreground : t.dim)
        .when(index === this.at, el => el.bg(t.selected))
        .hover(s => s.bg(t.hover)).tooltip(item.path ?? "")
        .on_click((_e, cx) => this.choose(index, cx))
        .child(div().child(item.label))));
  }
}
