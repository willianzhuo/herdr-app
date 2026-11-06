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
queues one fullscreen exit after the close delegate returns, waits for AppKit's
did-exit delegate, then hides
asynchronously without holding the window state lock. Repeated requests coalesce;
a hide during an already-running exit waits instead of toggling fullscreen back.
A failed native exit clears the pending request so another click can retry.

This leaves the app, core and terminals running. Reopening returns to a normal
window; fullscreen can be entered again. To load an installed app update, use
Cmd+Q and reopen: the red button only hides the running version.

## Agent presence when reports are cleared

The custom sidebar separates a running agent's presence from its current status.
A Claude dashboard/session switch can leave core with `reported: true` but a null
current status while the foreground Claude process remains alive. The sidebar
now supplements reporting agents with live, pane-owned processes recognized by
the `knownAgents()` program table, even if that program is not installed locally.

Such rows show **Status unknown** / a gray question mark, retain their own title,
can be focused by clicking, and are replaced by real reported states without
duplication. Full remote terminal addresses prevent cross-machine collisions.
Returning to a shell/editor or ending the process removes the fallback. The
presence fallback does not generate busy/done states, notifications or core data;
agent API/cycle navigation and rollups continue to use actual status reports.

Regression coverage includes report → cleared report → resumed session,
finished processes, shell/editor transitions, duplicate panels, remote addresses,
both priority/grouped rendering, and one workspace header when reported and
unreported sessions are mixed. Rows merge in pane order and groups are keyed by
workspace identity rather than by adjacency. This mod can hot reload without restarting
any running Claude or Traex session.

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
app home. Custom releases check this fork for updates; to incorporate official
changes, merge upstream, verify, and publish a new custom release.

## In-app updates from GitHub

Starting with `custom-v0.1.13.7`, packaged macOS builds check the public GitHub
Releases API ten seconds after launch and hourly. Settings → Updates → Check now
can trigger a check at any time. The checker includes preview releases and
selects the highest numeric `custom-v<upstream>.<build>` with a complete archive
for the current architecture. Official `v*` releases, drafts, DMG-only releases,
older versions and assets outside this fork's release URL are ignored.

The updater verifies GitHub's asset SHA-256 digest, the bundle signature and
identity, and the executable's full version before staging beside the installed
app. A Restart to update action swaps the bundle and relaunches its portable
launcher. Quit also applies a downloaded update; a verified pending update can
be recovered on the next launch after a crash. App preferences remain outside
the bundle, and custom app updates never implicitly update/restart herdr-core.
Core updates remain available as a separate explicit action in Settings.

Install the app into a writable Applications folder (for example
`~/Applications`); updating directly on the mounted read-only DMG is unsupported.
Network, API rate-limit and write-permission failures appear in Settings and can
be retried. GitHub access is required, but recipients need no GitHub account or
`gh` login for this public fork. These ad-hoc signed previews still require the
usual first-install macOS trust decision; SHA-256 and local codesign verification
do not replace Developer ID signing or notarization.

Versions through `.6` have no fork updater: users install `.7` or later manually
once. Local mod hot reload only watches local files; it does not distribute new
GitHub releases. Native code updates use a downloaded app and restart.

## Sharing a macOS preview

On an Apple Silicon Mac, run `./scripts/package-custom-macos`. It builds a release
binary and writes a DMG and updater `.tar.gz`, each with a SHA-256 checksum,
into `dist/`. Rust stable, Zig 0.16,
Python 3, and Apple's command line tools are required. For an already built binary,
pass its path as the first argument and set `CUSTOM_BUILD_PROFILE` to its actual
Cargo profile. `CUSTOM_BUILD_NUMBER` defaults to 1 and controls the package revision.
The packager sets `HERDR_CUSTOM_VERSION=<Cargo version>.<build>` while compiling;
an externally supplied binary must have been built with that exact value.
`--version`, Settings, package metadata, and the GitHub tag must agree.

The packager stages only the executable, icon, licenses, generic launcher, build
metadata and installation guide. It never copies an installed app's preferences.
The recipient uses their own `~/.config/herdr-custom`; herdr-core must be installed
separately (minimum 0.1.11, tested with 0.1.18). Existing core state can be shared
with the official app. This preview is ad-hoc signed, not Apple notarized; macOS
may block opening it. It has only been runtime-tested on macOS 26.6.2 arm64.

Publish custom packages only to this fork, using tags such as
`custom-v0.1.13.1`. Do not use `v*` tags: those trigger the upstream release
workflow. Upload both archives and checksums to a draft first; publish only when
all assets are uploaded and GitHub reports the updater archive's SHA-256 digest.
Each updater archive must be named
`Herdr-Custom-<version>.<build>-macos-arm64-update.tar.gz` and contain
`Herdr Custom.app` at its root. Never replace a published build's assets: bump
the build number. Include the
architecture, core prerequisite, changes, and signing limitations in its notes.
