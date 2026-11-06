//! App-owned pane grips and drag gestures, independent of header mods.
use super::*;
use crate::layout::Edge;

pub(super) struct PaneDrag {
    pane: String,
    tab: String,
    down: Point<Pixels>,
    at: Point<Pixels>,
    moving: bool,
    releasing: bool,
    target: Option<(String, Option<Edge>)>,
    bar: Option<(Option<String>, Bounds<Pixels>, Instant)>,
}

/// The outer quarter of a pane chooses its nearest edge; the middle swaps.
fn drop_zone(bounds: Bounds<Pixels>, at: Point<Pixels>) -> Option<Option<Edge>> {
    if !bounds.contains(&at) || bounds.size.width <= px(0.) || bounds.size.height <= px(0.) {
        return None;
    }
    let x = f32::from(at.x - bounds.origin.x) / f32::from(bounds.size.width);
    let y = f32::from(at.y - bounds.origin.y) / f32::from(bounds.size.height);
    let (distance, edge) = [(x, Edge::Left), (1. - x, Edge::Right), (y, Edge::Top), (1. - y, Edge::Bottom)]
        .into_iter().min_by(|a, b| a.0.total_cmp(&b.0)).unwrap();
    Some((distance < 0.25).then_some(edge))
}

/// The top row of a pane without a top header.
const STRIP: f32 = 18.;

fn top_strip(mut bounds: Bounds<Pixels>, row: f32, at: Point<Pixels>) -> bool {
    bounds.size.height = bounds.size.height.min(settings::z(row));
    bounds.contains(&at)
}

fn inherited_movable(root: &Node, id: &str) -> Option<bool> {
    root.path_to(id)?.iter().rev().find_map(|id| root.find(id)?.movable)
}

impl AppWindow {
    pub(super) fn pane_movable(&self, pane: &str) -> bool {
        let Some(tab) = self.model.tab_of(pane) else { return false };
        if tab.zoomed.is_some() || !tab.root.find(pane).is_some_and(Node::is_pane) {
            return false;
        }
        let owner = self.chrome.visible_blocks().into_iter().find(|n| matches!(n.content(), Some(Content::Context { .. })));
        inherited_movable(&tab.root, pane)
            .or_else(|| owner.and_then(|n| inherited_movable(&self.chrome, &n.id)))
            .unwrap_or(true)
    }

    pub(super) fn pane_grip(&self, pane: &str, header: Option<f32>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let row = header.unwrap_or(STRIP).max(STRIP);
        self.pane_grip_rows.borrow_mut().insert(pane.to_owned(), row);
        if !self.pane_movable(pane) { return None; }
        let dragging = self.pane_drag.as_ref().is_some_and(|d| d.pane == pane);
        if self.pane_grip_hover.as_deref() != Some(pane) && !dragging { return None; }
        let pane = pane.to_owned();
        Some(div().id(SharedString::from(format!("grip-{pane}")))
            .absolute().top(settings::z((row - 18.) / 2.)).left(relative(0.5)).ml(-settings::z(14.))
            .w(settings::z(28.)).h(settings::z(18.)).rounded(settings::z(4.))
            .bg(c("background").opacity(0.85))
            .hover(|s| s.bg(c("hover")))
            .flex().flex_col().items_center().justify_center().gap(settings::z(3.)).occlude()
            .group("pane-grip")
            .cursor(if dragging { CursorStyle::ClosedHand } else { CursorStyle::OpenHand })
            .on_mouse_down(MouseButton::Left, cx.listener(move |this, ev: &MouseDownEvent, _, cx| {
                this.pane_press(&pane, ev.position, cx);
                cx.stop_propagation();
            }))
            .children((0..2).map(|_| div().flex().gap(settings::z(3.)).children((0..3).map(|_| div().size(settings::z(2.)).rounded_full()
                .bg(if dragging { c("foreground") } else { c("dim") })
                .group_hover("pane-grip", |s| s.bg(c("foreground")))))))
            .into_any_element())
    }

    fn pane_hover(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let hovered = self.model.active_tab().and_then(|tab| {
            let bounds = self.bounds.borrow();
            let rows = self.pane_grip_rows.borrow();
            tab.shown().visible_blocks().into_iter().find_map(|n| {
                let b = bounds.get(&n.id)?;
                let row = rows.get(&n.id).copied().unwrap_or(STRIP);
                (self.pane_movable(&n.id) && top_strip(*b, row, at)).then(|| n.id.clone())
            })
        });
        if hovered != self.pane_grip_hover {
            self.pane_grip_hover = hovered;
            cx.notify();
        }
    }

    pub(super) fn pane_press(&mut self, pane: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.pane_movable(pane) {
            self.pane_drag = Some(PaneDrag {
                pane: pane.to_owned(), tab: self.model.active_tab().unwrap().id.clone(),
                down: at, at, moving: false, releasing: false, target: None, bar: None,
            });
            mods::set_shared("pane.dragging".into(), json!({"pane":pane}));
            cx.notify();
        }
    }

    fn pane_target(&self, at: Point<Pixels>) -> Option<(String, Option<Edge>)> {
        let d = self.pane_drag.as_ref()?;
        let tab = self.model.active_tab().filter(|t| t.zoomed.is_none())?;
        let bounds = self.bounds.borrow();
        tab.shown().visible_blocks().into_iter().filter(|n| n.is_pane() && n.id != d.pane)
            .find_map(|n| Some((n.id.clone(), drop_zone(*bounds.get(&n.id)?, at)?)))
    }

    fn pane_move(&mut self, at: Point<Pixels>, pressed: bool, cx: &mut Context<Self>) {
        let Some(d) = self.pane_drag.as_mut() else { return };
        if d.releasing { return; }
        if !pressed {
            self.cancel_pane_drag(cx);
            return;
        }
        if !d.moving && (at.x - d.down.x).abs().max((at.y - d.down.y).abs()) < settings::z(4.) {
            return;
        }
        d.moving = true;
        d.at = at;
        let target = self.pane_target(at);
        self.pane_drag.as_mut().unwrap().target = target;
        cx.notify();
    }

    pub(super) fn cancel_pane_drag(&mut self, cx: &mut Context<Self>) {
        if self.pane_drag.take().is_some() {
            mods::set_shared("pane.dragging".into(), Value::Null);
            cx.notify();
        }
    }

    fn queue_pane_release(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(drag) = self.pane_drag.as_mut() else { return false };
        if drag.releasing { return true; }
        drag.releasing = true;
        // Tab bars report geometry through the mod request channel. Give the
        // final pointer event one frame to reach it before resolving the drop.
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(32)).await;
            let _ = this.update_in(cx, |this, window, cx| this.pane_release(at, window, cx));
        }).detach();
        true
    }

    fn pane_release(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let target = self.pane_target(at);
        let Some(d) = self.pane_drag.take() else { return false };
        mods::set_shared("pane.dragging".into(), Value::Null);
        if !d.moving {
            cx.notify();
            return true;
        }
        if self.pane_movable(&d.pane) {
            if let Some((target, edge)) = target {
                if self.model.tab_of(&target).is_some_and(|t| t.id == d.tab) {
                    if self.model.move_pane(&d.pane, &target, edge) { self.sync(window, cx); }
                } else {
                    self.start_pane_relocation(&d.pane, Some(target), edge.unwrap_or(Edge::Right), window, cx);
                }
            } else if let Some((tab, bounds, _)) = d.bar.filter(|(_, b, _)| b.contains(&at)) {
                let _ = bounds;
                if let Some(tab) = tab {
                    let target = self.model.tab(&tab).and_then(|t| t.root.panes().first().map(|n| n.id.clone()));
                    if let Some(target) = target { self.start_pane_relocation(&d.pane, Some(target), Edge::Right, window, cx); }
                } else { self.start_pane_relocation(&d.pane, None, Edge::Right, window, cx); }
            }
        }
        cx.defer_in(window, |this, window, cx| this.restore_focus(window, cx));
        cx.notify();
        true
    }

    /// Tab bars register their real painted bounds, so custom widths, zoom,
    /// horizontal scrolling and sidebar sizes do not need to be guessed.
    pub(super) fn register_pane_drop_target(&mut self, args: &Value, window: &mut Window, cx: &mut Context<Self>) {
        let Some(drag) = self.pane_drag.as_ref().filter(|d| d.moving) else { return };
        let Some(source_space) = self.model.space_of(&drag.pane) else { return };
        let tab = args["tab"].as_str().map(str::to_owned);
        if let Some(tab) = &tab {
            if !source_space.tabs.iter().any(|t| &t.id == tab) { return; }
        }
        let number = |key: &str| args[key].as_f64().filter(|n| n.is_finite()).map(|n| px(n as f32));
        let (Some(x),Some(y),Some(width),Some(height)) = (number("x"),number("y"),number("width"),number("height")) else { return };
        if width <= px(0.) || height <= px(0.) { return; }
        let bounds = Bounds::new(point(x,y),size(width,height));
        let same = drag.bar.as_ref().is_some_and(|(old, _, _)| *old == tab);
        let pane = drag.pane.clone();
        let since = if same { drag.bar.as_ref().unwrap().2 } else { Instant::now() };
        self.pane_drag.as_mut().unwrap().bar = Some((tab.clone(), bounds, since));
        if !same && let Some(tab) = tab {
            cx.spawn_in(window, async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(400)).await;
                let _ = this.update_in(cx, |this, window, cx| {
                    let valid = this.pane_drag.as_ref().is_some_and(|d| d.pane == pane && d.bar.as_ref().is_some_and(|(t,b,start)| t.as_deref()==Some(&tab) && *start==since && b.contains(&window.mouse_position())));
                    if valid && this.model.select_tab(&tab) { this.sync(window, cx); }
                });
            }).detach();
        }
        cx.notify();
    }

    fn start_pane_relocation(&mut self, pane: &str, target: Option<String>, edge: Edge, window: &mut Window, cx: &mut Context<Self>) {
        let Some(space) = self.model.space_of(pane) else { return };
        let space_id = space.id.clone();
        let machine = space.machine.clone();
        let Some(address) = self.model.address_of(pane) else { return };
        if self.changing_terminals.contains(&address) {
            self.layout_notice("Pane is already moving", "Wait for the current move to finish.", window, cx);
            return;
        }
        if let Err(error) = self.require_document(machine.as_deref()) {
            self.layout_notice("Could not move pane", &error, window, cx);
            return;
        }
        let tab = if let Some(target) = target.as_deref() {
            if self.model.space_of(target).map(|s| &s.id) != Some(&space_id) { return; }
            let Some(tab) = self.model.tab_of(target) else { return };
            if self.model.tab_of(pane).is_some_and(|t| t.id == tab.id) { return; }
            tab.id.clone()
        } else {
            if self.model.tab_of(pane).is_none_or(|t| t.root.panes().len() < 2) { return; }
            self.model.fresh_id_on("tb", machine.as_deref())
        };
        self.start_terminal_change(address, TerminalChange::Move { space:space_id, tab, pane:pane.to_owned(), target, edge }, window, cx);
    }

    pub(super) fn pane_drag_layer(&self, cx: &mut Context<Self>) -> AnyElement {
        let preview = self.pane_drag.as_ref().and_then(|d| d.target.as_ref()).and_then(|(id, edge)| {
            let mut b = *self.bounds.borrow().get(id)?;
            match edge {
                Some(Edge::Left) => b.size.width /= 2.,
                Some(Edge::Right) => { b.size.width /= 2.; b.origin.x += b.size.width; }
                Some(Edge::Top) => b.size.height /= 2.,
                Some(Edge::Bottom) => { b.size.height /= 2.; b.origin.y += b.size.height; }
                None => {}
            }
            Some(div().absolute().left(b.origin.x).top(b.origin.y).w(b.size.width).h(b.size.height)
                .bg(c("accent").opacity(0.18)).border_2().border_color(c("accent")).into_any_element())
        });
        let preview = preview.or_else(|| {
            let drag = self.pane_drag.as_ref()?;
            let (_, b, _) = drag.bar.as_ref().filter(|(_, b, _)| b.contains(&drag.at))?;
            Some(div().absolute().left(b.origin.x).top(b.origin.y).w(b.size.width).h(b.size.height)
                .bg(c("accent").opacity(0.22)).border_2().border_color(c("accent")).into_any_element())
        });
        let this = cx.entity().downgrade();
        div().id("pane-drag-layer").absolute().inset_0()
            .when(self.pane_drag.is_some(), |d| d.cursor(CursorStyle::ClosedHand))
            .children(preview).child(canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = t.update(cx, |this, cx| {
                            this.pane_hover(ev.position, cx);
                            this.pane_move(ev.position, ev.pressed_button == Some(MouseButton::Left), cx);
                        });
                    }
                });
                let t = this.clone();
                window.on_mouse_event(move |ev: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Capture && ev.button == MouseButton::Left
                        && t.update(cx, |this, cx| this.queue_pane_release(ev.position, window, cx)).unwrap_or(false)
                    { cx.stop_propagation(); }
                });
            },
        ).absolute().size_full()).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{STRIP, drop_zone, inherited_movable, top_strip};
    use crate::layout::{Axis, Content, Edge, Node};
    use gpui::{Bounds, point, px, size};
    #[test]
    fn zones_are_relative_to_the_pane_and_outside_cancels() {
        let b = Bounds::new(point(px(100.), px(200.)), size(px(800.), px(400.)));
        for (x, y, expected) in [(500., 400., Some(None)), (110., 400., Some(Some(Edge::Left))),
            (890., 400., Some(Some(Edge::Right))), (500., 210., Some(Some(Edge::Top))),
            (500., 590., Some(Some(Edge::Bottom))), (99., 400., None)] {
            assert_eq!(drop_zone(b, point(px(x), px(y))), expected);
        }
    }
    #[test]
    fn hover_strip_is_only_the_panes_top_edge() {
        let b = Bounds::new(point(px(100.), px(200.)), size(px(800.), px(400.)));
        assert!(top_strip(b, STRIP, point(px(110.), px(201.))));
        assert!(!top_strip(b, STRIP, point(px(110.), px(250.))));
        assert!(!top_strip(b, STRIP, point(px(99.), px(201.))));
        assert!(!top_strip(b, STRIP, point(px(500.), px(199.))));
        // A 40px top header is the whole row.
        assert!(top_strip(b, 40., point(px(110.), px(235.))));
        assert!(!top_strip(b, 40., point(px(110.), px(245.))));
    }
    #[test]
    fn movable_uses_the_nearest_explicit_ancestor() {
        let mut root = Node::container("root", Axis::Row, vec![Node::container("inner", Axis::Column,
            vec![Node::block("pane", Content::Terminal { terminal: "t1".into() })])]);
        assert_eq!(inherited_movable(&root, "pane"), None);
        root.movable = Some(false);
        assert_eq!(inherited_movable(&root, "pane"), Some(false));
        root.find_mut("inner").unwrap().movable = Some(true);
        assert_eq!(inherited_movable(&root, "pane"), Some(true));
    }
}
