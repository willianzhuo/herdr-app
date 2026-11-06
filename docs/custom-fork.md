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

## Focus and session titles

The agent list resolves every row by its own full terminal address, including
its machine prefix. It prefers that terminal's reported title, then its panel
or terminal title, terminal name and program name. Sibling panels and tab names
never supply an agent's label. Priority/pinned rows show the space as context.

The tab bar uses the last focused panel in each tab, remembers that choice in
its local storage, and follows the panel's reported/terminal title and icon.
Closing or moving the panel falls back to a remaining panel. Explicit descriptive
tab names stay fixed; numeric and program-name tabs follow focus. A newly installed
mod initially uses a tab's first panel until it observes focus in that tab.

To apply these mod changes to an older running custom app, copy
`defaults/mods/agents/main.js` into a personal `mods/agents-titles/` mod and point
the sidebar layout at it. Update an existing directory-routing tab bar from
`personal-config/tabs-copy-main.js`, keeping its companion directory helper and
machine map. These changes can hot reload without restarting terminals.
Session titles remain dependent on what each agent actually reports.

The Codex agent uses the current official ChatGPT icon at the fork owner's
request. Its unchanged source asset is recorded in `defaults/icons/SOURCE-ChatGPT.txt`.

## Traex recognition and native status

The program table maps the executable `traex` and reported identity `traecli`
to Traex, using the unchanged logo from the official TRAE GitHub organization
(see `defaults/icons/SOURCE-Traex.txt`). It is a colored image, not a tinted glyph.
The agent list and tab bar remove Traex's transient `Action Required |` prefix
from the session title.

An isolated test on a remote Linux development machine with core 0.1.18 confirmed
Traex 0.214.1 natively emits OSC 7501: idle, working, done, and blocked with
kind=permission. The app displayed it as an agent, showed Needs you, and posted
an approval toast while another tab was selected. Standard startup, inline mode,
and embedded-server mode were exercised without any custom status hook.
An explicitly pinned 0.213.1 process completed the same prompt but never reported
status. Existing old processes are left running; new sessions should use the
verified newer version. No core restart or global hook installation is required.

An early probe began with the CLI symlink on 0.213.1; the CLI's own startup updater
switched it to 0.214.1. Runtime `/proc/<pid>/exe` checks and a pinned-version control
confirmed which versions actually produced the reports. An invalid-model startup
failure was also observed, but native error-state notifications and full session
names beyond the terminal-provided title have not been verified. This integration
passes through native reports rather than inferring states from screen text.

## macOS display-transition crash fix

The macOS window backend now checks for a missing `NSScreen` before reading its
visible frame to determine whether a window is maximized. AppKit can temporarily
return no screen during display or Space transitions; the previous Cocoa wrapper
constructed a null Rust reference and aborted the application. During that short
interval the maximize query returns false and is recalculated on later frames.
The other visible-frame and screen/frame paths were checked for matching guards.

The regression test calls the production screen-size helper with `nil`; the
macOS backend's 21 unit tests pass. A real display unplug/reconfiguration race
has not been forced on the user's desktop. This patch concerns the app window,
not the independently running core or terminal processes.

## Hiding from native fullscreen on macOS

The macOS red close button still hides the app so background agent notifications
continue. When the active managed window is in native fullscreen, hiding first
requests one fullscreen exit, waits for AppKit's did-exit delegate, then hides
asynchronously without holding the window state lock. Repeated requests coalesce;
a hide during an already-running exit waits instead of toggling fullscreen back.
A failed native exit clears the pending request so another click can retry.

This leaves the app, core and terminals running. Reopening returns to a normal
window; fullscreen can be entered again. To load an installed app update, use
Cmd+Q and reopen: the red button only hides the running version.

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

## Sharing a macOS preview

On an Apple Silicon Mac, run `./scripts/package-custom-macos`. It builds a release
binary and writes a DMG plus SHA-256 checksum into `dist/`. Rust stable, Zig 0.16,
Python 3, and Apple's command line tools are required. For an already built binary,
pass its path as the first argument and set `CUSTOM_BUILD_PROFILE` to its actual
Cargo profile. `CUSTOM_BUILD_NUMBER` defaults to 1 and controls the package revision.

The packager stages only the executable, icon, licenses, generic launcher, build
metadata and installation guide. It never copies an installed app's preferences.
The recipient uses their own `~/.config/herdr-custom`; herdr-core must be installed
separately (minimum 0.1.11, tested with 0.1.18). Existing core state can be shared
with the official app. This preview is ad-hoc signed, not Apple notarized; macOS
may block opening it. It has only been runtime-tested on macOS 26.6.2 arm64.

Publish custom packages only to this fork, using tags such as
`custom-v0.1.13.1`. Do not use `v*` tags: those trigger the upstream release
workflow. Upload the DMG and checksum to a GitHub prerelease and include the
architecture, core prerequisite, changes, and signing limitations in its notes.
