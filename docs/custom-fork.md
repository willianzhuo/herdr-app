# Custom pane-drag build

This fork adds terminal-pane dragging between tabs within one workspace. It is
based on Herdr 0.1.13. The original terminal process and pane identity survive a
move; the terminal backend is unchanged.

- Drag a pane's top-center grip onto the blank area after the last tab to detach it.
- Drop onto another tab to add a right split, or hover for 400 ms to select that
  tab and then drop on a pane edge to choose the split direction.
- Escape or dropping outside a destination cancels. A tab's only pane can merge
  into another tab; detaching it into another single-pane tab is a no-op.
- Tabs have a minimum width of 160 px.

## Branches and remotes

Keep `master` as the upstream baseline and `custom` as the maintained custom
version. `origin` points to this fork; `upstream` points to
`https://github.com/herdrdev/herdr-app.git`. Do not push custom commits upstream.

To incorporate official changes, start with a clean working tree:

```sh
git switch custom
./scripts/sync-upstream
# Resolve any merge conflicts, then run the checks and rebuild.
git push origin custom
```

The sync script deliberately leaves conflicts for review and does not push,
replace an installed app, or restart running applications.

## Build and validation

Use Rust stable and Zig 0.16.0. Initialize the Ghostty submodule before building:

```sh
git submodule update --init --recursive --depth 1
cargo check --locked
cargo test --locked
cargo build --locked --release
```

`personal-config/tabs-copy-main.js` is an optional custom tab-bar example that
preserves machine-directory routing. Place its companion `personal-config/directory.js` beside it in the
local tab-bar mod folder. Copy the example machine-directory map into the app
home as `machine-directories.json` and adjust it for your own machines. The built-in `tabs` mod already supports the new drag targets.

The local validation included model/layout tests and actual detach/merge UI
operations. The test terminal's address, process PID, and creation time remained
unchanged across those operations.

Install private builds as a separate **Herdr Custom.app** with an independent
app home, rather than overwriting an official signed app. A private build does
not receive official app updates automatically; merge upstream and rebuild.
