use super::{AppWindow, Content, SWAP};
use gpui::*;

impl AppWindow {
    pub(super) fn pane_scale(&self, pane: &str) -> f32 {
        let steps = self.pane_zoom.get(pane).copied().unwrap_or(0).clamp(-5, 20);
        1.0 + f32::from(steps) / 10.0
    }

    pub(super) fn pane_under_pointer(&self, point: Point<Pixels>) -> Option<String> {
        let bounds = self.bounds.borrow();
        let contains = |id: &str| bounds.get(id).is_some_and(|b| b.contains(&point));
        if self.overlays.iter().any(|o| o.kind.modal_keys() || contains(&o.slot))
            || super::visible_nodes(&self.chrome).into_iter().any(|node| {
                node.floating.iter().any(|f| !f.hidden && contains(&super::floats::slot(&f.id)))
            })
        {
            return None;
        }
        for node in self.chrome.visible_blocks().into_iter().filter(|node| contains(&node.id)) {
            match node.content() {
                Some(Content::Context { .. }) => {
                    let tab = self.model.active_tab()?;
                    return tab.shown().visible_blocks().into_iter()
                        .find(|pane| pane.is_pane() && contains(&pane.id))
                        .map(|pane| pane.id.clone());
                }
                Some(Content::Terminal { .. }) => return Some(node.id.clone()),
                Some(Content::Agent { .. }) => {
                    let address = self.shown_agent()?;
                    return Some(self.model.pane_of(&address).unwrap_or_else(|| node.id.clone()));
                }
                _ => {}
            }
        }
        None
    }

    /// Returns false when the shortcut should use the global App zoom.
    pub(super) fn zoom_pane_at_pointer(&mut self, steps: i8, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(pane) = self.pane_under_pointer(window.mouse_position()) else { return false };
        let previous = self.pane_zoom.get(&pane).copied().unwrap_or(0);
        let next = if steps == 0 { 0 } else { previous.saturating_add(steps).clamp(-5, 20) };
        if next == previous { return true; }
        if next == 0 {
            self.pane_zoom.remove(&pane);
        } else {
            self.pane_zoom.insert(pane.clone(), next);
        }
        let scale = self.pane_scale(&pane);
        for slot in [&pane, &format!("{pane}{SWAP}")] {
            if let Some(term) = self.terms.get(slot) {
                term.view.update(cx, |view, cx| view.set_scale(scale, cx));
            }
        }
        self.save_view();
        // Invalidate the retained subtree so scripted content and its layout
        // are materialized under the new scale without remounting the view.
        window.refresh();
        cx.notify();
        true
    }
}

/// Keep the pane's bounds and hit testing in window coordinates, while scaling
/// the content's own text and dimensions through GPUI's normal layout passes.
pub(super) fn scale_mod(element: AnyElement, scale: f32) -> AnyElement {
    if scale == 1.0 { element } else { ScaledMod { element, scale }.into_any_element() }
}

struct ScaledMod {
    element: AnyElement,
    scale: f32,
}

impl IntoElement for ScaledMod {
    type Element = Self;
    fn into_element(self) -> Self { self }
}

impl Element for ScaledMod {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> { None }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> { None }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let rem = window.rem_size() * self.scale;
        let id = gpui_shell::with_pixel_scale(self.scale, || window.with_rem_size(Some(rem), |window| self.element.request_layout(window, cx)));
        (id, ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) {
        let rem = window.rem_size() * self.scale;
        gpui_shell::with_pixel_scale(self.scale, || window.with_rem_size(Some(rem), |window| self.element.prepaint(window, cx)));
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), _: &mut (), window: &mut Window, cx: &mut App) {
        let rem = window.rem_size() * self.scale;
        gpui_shell::with_pixel_scale(self.scale, || window.with_rem_size(Some(rem), |window| self.element.paint(window, cx)));
    }
}
