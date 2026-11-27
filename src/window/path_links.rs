use super::AppWindow;
use crate::links::{self, Location};
use gpui::{Context, Window};
use serde_json::json;
use std::path::PathBuf;

impl AppWindow {
    pub(super) fn open_path_link(
        &mut self,
        address: &str,
        cwd: Option<PathBuf>,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(space) = self.model.active_space().map(|s| s.id.clone()) else {
            self.command_error("Open path", "No workspace is open", window, cx);
            return;
        };
        let machine = address.split_once('/').map(|(on, _)| on.to_owned());
        let on = machine.clone();
        let lookup = cx.background_executor().spawn(async move { links::open_path(&path, cwd.as_deref(), on.as_deref()) });
        cx.spawn_in(window, async move |this, cx| {
            let resolved = lookup.await;
            let _ = this.update_in(cx, |this, window, cx| {
                // Don't pull the person back to a workspace they have left
                // while a remote path was still being resolved.
                if this.model.active.as_deref() != Some(&space) { return; }
                match resolved {
                    Ok(location) => this.show_path_link(location, space, machine, window, cx),
                    Err(error) => this.command_error("Open path", &error, window, cx),
                }
            });
        }).detach();
    }

    fn show_path_link(&mut self, location: Location, space: String, on: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(file) = location.file {
            self.run("tab.new", json!({ "space": space, "name": file, "mod": "file-panel", "props": {
                "path": location.path, "on": on, "title": file, "folder": location.folder
            }}), window, cx);
            return;
        }

        let Some(path) = self.chrome.path_to("files") else {
            self.command_error("Open directory", "This layout has no Files panel", window, cx);
            return;
        };
        for pair in path.windows(2) {
            self.chrome.select(&pair[0], &pair[1]);
        }
        for id in &path {
            if let Some(node) = self.chrome.find_mut(id) { node.hidden = false; }
        }
        self.sync(window, cx);
        let command = format!("open-directory:{}", json!({"space": space, "on": on, "folder": location.folder}));
        let handled = self.copies.get("files").is_some_and(|copy| crate::mods::send_command_to(copy.id, &command));
        if !handled {
            self.command_error("Open directory", "The active Files mod does not accept directory links", window, cx);
        }
    }
}
