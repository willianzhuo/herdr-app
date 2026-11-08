import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, exec, spaces, terminals, settings, shared, setShared, theme, props } from "herdr";
import { PortsController, PORTS_KEY } from "./controller.js";

export default class Ports extends View {
  init(_p,cx) {
    this.port=InputState.new({placeholder:"Remote TCP port"});
    this.target=InputState.new({placeholder:"SSH config alias"});
    this.port.on("change",(_e,cx)=>cx.notify());this.target.on("change",(_e,cx)=>cx.notify());
    cx.timer.every(5000,cx=>{this.controller?.refresh(cx);cx.notify();});
  }

  render(cx) {
    this.controller??=new PortsController({appHome,exec,spaces,terminals,settings,shared,setShared});
    this.controller.refresh(cx);
    const t=theme(),state=shared(PORTS_KEY)??{},machine=props()?.machine??spaces().find(s=>s.active)?.machine;
    const info=state.machines?.find(m=>m.name===machine),auto=state.auto?.[machine]!==false;
    const rows=(state.rows??[]).filter(r=>r.machine===machine);
    const issue=this.error||shared("ports.error")||state.scanErrors?.[machine]||state.scanErrors?.manager;
    const button=(id,label,action)=>div().id(id).px(8).py(5).rounded(5).cursor_pointer().text_color(t.muted).hover(s=>s.bg(t.hover)).on_click(action).child(label);
    const note=text=>div().p(10).text_size(12).text_color(t.dim).child(text);
    return v_flex().id("ports").size_full().min_h(0).bg(t.background).rounded(10).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Ports")).child(div().flex_1().text_color(t.dim).child(machine??"This computer"))
        .when(Boolean(machine),el=>el.child(button("ports-auto",auto?"Auto: on":"Auto: off",(_e,cx)=>this.controller.send("auto",{machine,enabled:!auto},cx)))
          .child(button("ports-stop-all","Stop all",(_e,cx)=>this.controller.send("stop-all",{machine},cx)))))
      .when(!machine,el=>el.child(note("Select an SSH workspace to discover and forward its development ports.")))
      .when(Boolean(machine),el=>el
        .child(note("SSH forwarding · local addresses stay on 127.0.0.1"))
        .when(Boolean(info?.state)&&info.state!=="connected",el=>el.child(note(`Port discovery is paused: machine ${String(info.state).replace(/_/g," ")}. Reconnect it in the sidebar.`)))
        .when(Boolean(info)&&!info.target,el=>el.child(v_flex().px(10).gap(5)
          .child(note("This custom transport needs its SSH config alias."))
          .child(h_flex().gap(5).child(Input.new(this.target).flex_1().h(30).px(8).border_1().border_color(t.border).rounded(5))
            .child(button("ports-target","Save",(_e,cx)=>this.controller.send("target",{machine,target:this.target.value().trim()},cx))))))
        .child(h_flex().px(10).gap(5).items_center().flex_none()
          .child(Input.new(this.port).flex_1().min_w(0).h(30).px(8).border_1().border_color(t.border).rounded(5))
          .child(button("ports-add","Forward",(_e,cx)=>{
            const text=this.port.value().trim(),port=Number(text);
            if(!/^\d+$/.test(text)||port<1||port>65535){this.error="Use a port from 1 to 65535";cx.notify();return;}
            this.error=null;this.controller.send("forward",{machine,port},cx);
          })))
        .when(Boolean(issue),el=>el.child(note(issue)))
        .child(v_flex().id("ports-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(7).children(rows.map(row=>v_flex().id(`port-${row.key}`).p(9).gap(5).rounded(7).border_1().border_color(t.border)
          .child(h_flex().gap(7).items_center().child(div().font_semibold().child(String(row.port)))
            .child(div().flex_1().truncate().text_color(t.dim).child(row.label||row.process||"Manual"))
            .child(div().text_color(row.state==="Forwarded"?t.done:t.dim).tooltip(row.error||row.state).child(row.state)))
          .when(Boolean(row.url),el=>el.child(div().cursor_pointer().text_color(t.accent).tooltip("Open in browser").on_click((_e,cx)=>cx.open_url(row.url)).child(row.url)))
          .child(h_flex().child(button(`port-action-${row.key}`,row.state==="Not forwarded"?"Forward":"Stop",(_e,cx)=>this.controller.send(row.state==="Not forwarded"?"forward":"stop",{machine,port:row.port},cx)))
            .when(Boolean(row.url),el=>el.child(button(`port-copy-${row.key}`,"Copy address",(_e,cx)=>cx.write_to_clipboard(`127.0.0.1:${row.local}`)))))))
          .when(!rows.length,el=>el.child(note("No development ports found yet. New listening services started from this machine's Herdr terminals are detected automatically; other services can be added above.")))));
  }
}
