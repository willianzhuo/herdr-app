# Custom pane-drag build

This fork adds terminal-pane dragging between tabs within one workspace. It is
based on Herdr 0.1.13. The original terminal process and pane identity survive a
move; the terminal backend is unchanged.

- Drag a pane's top-center grip onto the blank area after the last tab to detach it.
- Drop onto another tab to add a right split, or hover for 400 ms to select that
  tab and then drop on a pane edge to choose the split direction.
- Escape or dropping outside a destination cancels. A tab's only pane can merge
  into another tab; detaching it into another single-pane tab is a no-op.
- Tabs have a fixed width (default 220 logical px), with reserved icon, status and close
  slots. Focus/title/status changes do not resize tabs. Long titles truncate and
  remain available in a tooltip.

Settings → Look → **Tab width** adjusts all tabs from 160 to 400 px in 20 px steps;
Reset restores 220 px. The preference follows app zoom, applies immediately and
persists in the app home's `shared.json` as `tabs.width`. The built-in tab bar and
updated `personal-config/tabs-copy-main.js` both honor it. Older personal copies
need the updated tab mod code. This setting does not alter session titles or
machine layout documents.

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
`session-titles.js` plus the machine map. These changes can hot reload without restarting terminals.
Other agents continue to use their own reported/terminal titles.

Traex additionally resolves its real saved session name, which its OSC terminal
title may omit (for example, every session reports `work`). A read-only Python 3
probe runs on the terminal's own machine, identifies the foreground process's
currently open rollout or session writer lock, and looks up that exact ID in the
CLI's SQLite/index metadata. The sidebar, focused tab and pane headers share the
result. Two agents in the same cwd retain different names; resume launch arguments
and the most recently modified workspace session are never used as identity.

Probes batch by machine, coalesce across the sidebar/tab bar and refresh every
five seconds. Results are tied to the full terminal address, foreground PID and
terminal creation time, expire after 20 seconds, and are ignored after process
exit/replacement. Ambiguous open sessions, unsaved sessions without a stored name,
missing Python 3 or unavailable files keep the normal terminal-title fallback.
There are no status writes, settings changes, database migrations or process input.
Linux `/proc` probing was verified against separate live 200 sessions. The macOS
path uses `ps`/`lsof`; a live local Traex session has not been tested.

Each mod's sandbox requires a local helper copy. Treat
`defaults/mods/agents/session-titles.js` as canonical and copy it unchanged into
`tabs`, `pane`, `terminals-pane` and `personal-config` when editing. The tests
enforce identical copies. No new native mod API is required.

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

Claude Agent View background sessions now have a display fallback on Linux.
`claude-status.js` calls the foreground process's own executable with
`agents --json --all`, using its own HOME and CLAUDE_CONFIG_DIR. It reads the
supported CLI state API rather than depending on the internal jobs/state files.
The terminal's current title, after removing its leading status glyph, must
match exactly one background session name in that profile. It never selects a
session by cwd, age, a launch-time resume argument, or another panel's title.
Duplicate/unmatched names stay unknown. Matching depends on Claude
retaining that session name in the terminal title; no title means no fallback.
The documented `claude agents` dashboard title (including its awaiting-input
prefix) instead produces a Claude Dashboard profile-wide summary. It counts
background states, prioritizes blocked over working, and is idle when neither
exists. Historical failed/stopped tasks are counted in its tooltip, not treated
as newly blocked work. The label and tooltip distinguish the dashboard's full
profile scope from sessions belonging to the containing workspace. Attaching
to a session replaces the summary with that specific session's state.

The CLI's coarse `state` is authoritative even when its process `status` is idle
between autonomous steps: working stays working, blocked stays Needs you, done
stays done (idle in the focused sidebar row), and failed/stopped need attention.
Native OSC reports take priority. Sidebar, tab rollups and framed pane headers
share a cache bound to address, foreground PID, terminal creation and current
title. Polls batch by machine/profile about every five seconds; cached entries
expire after 12 seconds and stale in-flight reads cannot follow a session switch.
Python 3 and readable Linux /proc metadata are needed; unavailable/unsupported
machines keep Status unknown. No prompts, hooks, job files, core status writes,
process restarts or new notifications are involved.

The supported state fields and background reporting limitation are documented
in [Claude Agent View](https://code.claude.com/docs/en/agent-view#read-session-state-from-a-script)
and [terminal configuration](https://code.claude.com/docs/en/terminal-config#see-session-status-in-your-terminal).

Regression coverage includes report → cleared report → resumed session,
finished processes, shell/editor transitions, duplicate panels, remote addresses,
both priority/grouped rendering, and one workspace header when reported and
unreported sessions are mixed. Rows merge in pane order and groups are keyed by
workspace identity rather than by adjacency. This mod can hot reload without restarting
any running Claude or Traex session.

## Markdown in Files

The Files address bar accepts a folder path on the current machine: press Enter
or **打开** to browse it. Absolute paths, `~`/`~/…`, and paths relative to the
current Files root work; missing, inaccessible or non-folder targets show an
error. Manual navigation stays pinned per machine/workspace for the lifetime
of the view, even when terminal cwd changes. **跟随终端** resumes automatic
following. This changes only Files, not the terminal's working directory.

Right-click a folder for **复制相对路径** or **复制绝对路径**. The relative
path starts at the current Files root; the root label's menu copies `.` or its
absolute path. SSH paths refer to the remote filesystem and are copied as
literal text to the local clipboard, without a machine prefix or shell quoting.
The menu captures the clicked path so later focus changes cannot change it.

The right Files panel renders Markdown by default, including headings, lists,
quotes, fenced code, tables and links supported by native `TextView`. Preview /
Source switches to the existing read-only editor using the same bounded content.
Text is selectable and scrollable. Refresh reloads the selected file; Markdown
also follows the ten-second Files refresh and local folder notifications.
Remote Markdown is read through the same machine-aware API as other previews.
Empty files work, oversized previews are marked as truncated, and removed,
binary or unreadable files show the existing error state. Stale reads cannot
replace a newer file, even after closing/reopening the same path.

**Panel** opens the selected file as a right split beside the focused pane;
**New tab** opens it in its own tab. The `file-panel` mod stores only the file's
path, machine and display metadata in pane props, not file contents. Its
document remains fixed when terminal focus changes, and is restored with the
workspace layout. It uses the same bounded read-only preview/source code as
Files (`file-panel/files.js` is an identical sandbox-local copy, checked by tests).
Resize, zoom and close it like a terminal pane, or drag its top-center grip to
rearrange it, merge it into another tab, or detach it onto the tab-bar blank area.
Cross-tab movement stays within the same workspace and retains the pane id,
props and view; no terminal labels or processes are changed for mod-pane moves.
Pane headers and focused-tab labels use the optional mod `props.title` and
`props.folder` through the existing pane title/cwd fields.

This is a hot-loadable mod change. Clone the built-in Files mod to a personal
`files-markdown`, update its `main.js` from `defaults/mods/files/main.js` while
rewriting its icon paths to `mods/files-markdown/`, and point the active personal
layout's Files block at the clone. Personal copies survive app restarts and
updates. Relative images/links are not mapped across SSH; rendered resources
follow TextView's existing sandbox and HTTP(S) URL policy. No webview, new native
API, dependency or file write is needed for previews. Cross-tab movement of
file/mod panes requires the updated native Custom build; hot-loading the mods
alone enables file panels, same-tab movement and previews in older builds.
Install `defaults/mods/file-path-menu` in the same app home's `mods/` directory
for the folder clipboard menu. Fixed file panels retain their file and machine;
the directory navigation bar is only shown in Files.

## Branches and remotes

The 2026-11-07 selective sync takes these upstream commits, rather than merging
the entire official branch:

- `207dbdc`: swap two panes by ID within one tab.
- `e7a6a91`, `99fa122`, `8ea7dcd`: test cleanup and deterministic command/file notifications.
- `be1e225`: keep layout previews inside their cards.
- `1eb838f`: close the modal dialog before closing the terminal behind it with a key.
- `0e1b180`: preserve authored layout and panes on transient reconnect/attach errors.
- `0b24b69`: wait briefly for the actual pane size before terminal replay.
- `e5ba294`: distinguish a failed core connection from a missing core and offer Retry.

The custom cross-tab pane-drag implementation and its model move/relocate methods
remain unchanged. The new upstream swap command is independent. Session naming,
Traex presence/status integration, custom icons, fullscreen hiding and the fork
updater remain intact. PR #1's configurable tab width is included from `custom`.
The upstream agent-title rewrite, Codex daemon launch flag, Add machine workflow,
Windows-specific detection, Kimi aliases and macOS CLI-check launcher are not part
of this selection. The same test-only dispatch treatment as `exec` is also applied
to `knownAgents()` so it cannot wake GPUI's deterministic scheduler from an OS
thread; production dispatch is unchanged.

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

### Diagnose a slow SSH entry path

`scripts/check-core-ssh.py <ssh-alias>` tests an independent SSH connection,
the actual peer hello and bounded no-op requests at 0, 4 KiB and 16 KiB. It
attaches no terminal and sends no input to an agent. `--gateway <hostname>` and
`--port <port>` let an operator compare an approved alternate entry point while
retaining the original alias's SSH user and authentication. `--sizes` accepts
payloads up to 64 KiB; `--report <path>` writes a private JSON report.

Compare `core_id` before switching: an alternate gateway must reach the same
core. Separate cold SSH authentication time, warm request RTT and `remote_ms`.
If only one entry path stalls as request size grows, prefer a verified working
entry over permanently throttling all input. A 4 KiB shell initializer alone
needs over 1.6 seconds at the paced adapter's 2.56 KiB/s ceiling; layout writes
and other automatic requests add to this even without a large user paste.

A verified unthrottled route can be stored in the local machine profile with
`hc machine add --name <existing-name> --via 'ssh -o HostName=<alternate> -p <port> -T <original-alias>'`.
Back up the existing profile first; replacing it requires removing only that
local connection profile and pairing the same core again. Keep its existing
name/id and private directory mapping; never stop the remote core, holder or
agents for an entry-path change. Test repeated requests and automatic reconnect
in an isolated local core before replacing the user's profile. Personal
gateways, machine accounts and actual route choices are not shipped in this repo.

Revalidate the original alias after replacing a development machine or repairing
its entry path. If the standard route passes the peer handshake and larger
requests, restore `target=<original-alias>, via=false` rather than retaining an
old alternate gateway, forced address family or pacing adapter. Back up the
profile and verify the same remote core and live terminal identities across the
connection-only replacement. Archive inactive private helpers; keep independent
features such as directory mapping, interactive colors and latency preferences.

### Machine response time

The Spaces machine headings show remote response time in `ms`, refreshed every
15 seconds while the window is active. The optional latency module uses the
existing core route (including a configured `--via` adapter), executing only
`true` outside any terminal with a five-second bound. Values include core
dispatch and remote process startup; they are not ICMP ping measurements.
Click any latency badge or the settings icon in the Spaces heading for the
inline controls. Detection can be disabled (no new probes, badges hidden), and
the high-latency warning and timeout are editable in milliseconds. Defaults are
500 ms for a yellow warning and 5000 ms for timeout. Timeout accepts 100–60000 ms
and must exceed the warning. A pending sample displays timeout at its deadline;
the core exec wrapper may take up to another five seconds to finish cleanup.
All machines share these preferences, persisted in sidebar localStorage under
`machines.latency.settings`; reloading the mod or reopening the app retains them.
Each machine has its own in-flight guard and shared lease. Offline, failed,
timed-out and stale samples never masquerade as current successful readings.
No second SSH connection, agent input or terminal restart is involved.

### SSH input-burst compatibility transport

`scripts/ssh-paced.py SSH_TARGET REMOTE_COMMAND` is an optional transparent
transport for SSH paths that accept small input but stall on larger bursts.
For example, install the script in a stable local path and pair with
`hc machine add --name your-machine --via 'python3 /path/ssh-paced.py your-ssh-target'`.
Only use it when that connection needs it: input is limited to 128-byte pieces
at 50 ms intervals (about 2.56 KB/s); output is unthrottled and never recorded.
Even an initial core-to-core hello (268 bytes in the reproduced case) can
trigger the gateway stall before any terminal input. A simple preliminary
hello succeeds, so a machine can appear paired while its actual peer handshake
never completes. The previous 256-byte/20-ms pacing still failed this handshake;
128-byte/50-ms pacing passed both that handshake and repeated core requests.
It waits for a private remote readiness marker before reading local stdin, so
SSH authentication cannot accumulate the paced writes into a single burst.
The marker is consumed by the adapter and never enters the core protocol.
Readiness has a 30-second deadline; readiness/errors are timestamped on stderr
for transport diagnostics, without recording input or terminal output.
The existing core supervisor handles reconnects. It is not a hung-RPC watchdog
and does not restart cores or resume interrupted tasks. An affected SSH path
was verified with repeated requests and a 12,032-byte binary SHA-256 comparison.
No personal machine names, SSH credentials or routing settings are shipped.
Run `python3 scripts/test_ssh_paced.py -v` for an isolated delayed-channel test
covering binary transparency, command quoting, exit status and handshake errors.

### Remote shell directory preservation

The optional `personal-config/directory.js` keeps new workspaces in the mapped
machine directory; new tabs keep the focused terminal's directory, including an
explicit project/worktree override. Copy `scripts/install-shell-directory.py`
into the custom app home as `shell-directory-install.py` alongside the machine
map. Updated directory helpers prepare mapped Unix machines before creating a
terminal; local machines, Windows mappings and mod-only tabs skip this step.

Preparation installs two marked blocks in the remote user's `.bashrc` and a
helper at `~/.config/herdr-custom/shell-directory.bash`. A first-original backup
is kept beside `.bashrc` as `.bashrc.herdr-directory-v1.bak`. Only interactive
core terminals (`HC_TERMINAL_ID`) capture their requested directory before
platform startup files and restore it afterward. The exported capture survives
platform startup scripts that `exec` another Bash. Ordinary SSH shells and
noninteractive commands retain their existing behavior. Platform-generated
`.bash_aliases` is never modified, so regenerating it does not remove this fix.

This covers both new terminals and core keep recovery after a machine restart.
It preserves the directory supplied by core, rather than forcing every shell
to one global path. Existing running shells/agents are not sent input or moved;
their directory changes only through their own commands. Agent tasks are never
automatically resumed. Run the installer on the remote machine with `--remove`
to remove only its managed blocks/helper; other user configuration is retained.

The fix can hot load into an installed Custom app: update every personal mod's
`directory.js` copy and the app-home installer, then prepare the affected remote
machine once. No native executable or core restart is required. Verify with
`python3 scripts/test_shell_directory.py` and `bun test scripts/directory.test.ts`.
An isolated Linux core 0.1.18 test verified both fresh terminals and kept-shell
recovery after stopping the test core and reattaching: the default work folder
and a different project path containing spaces/apostrophes were retained. Only
the isolated test terminals were stopped; existing user terminals were untouched.

Use Rust stable and Zig 0.16.0. Initialize the Ghostty submodule before building:

```sh
git submodule update --init --recursive --depth 1
cargo check --locked
cargo test --locked
cargo build --locked --release
```

`personal-config/tabs-copy-main.js` is an optional custom tab-bar example that
preserves machine-directory routing. Place its companions `personal-config/directory.js`
and `personal-config/session-titles.js` beside it in the
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
separately (minimum 0.1.11, tested with 0.1.18 and 0.1.19). Existing core state can be shared
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

`custom-v0.1.13.11` consolidates PRs #2–#6 on the maintained `custom` branch.
It includes the original custom drag implementation, Markdown/file panels,
Claude background-session status, launcher color handling and Ports/monitor
registration. Local validation runs the full JavaScript suite, native tests and
renderer pixel checks; packaging validates both the DMG and updater archive.
Core remains separately installed and updated. On macOS, granting ordinary
folder write access is insufficient when App Management blocks Custom from
modifying the independently signed Herdr Core.app.

`custom-v0.1.13.12` includes the subsequent Files folder address bar and path
clipboard menu, configurable machine response-time badges, stale-badge recovery,
and the opt-in Bash color-guard extension. All existing fork PRs are already
merged into `custom`; the new changes were committed directly to that branch.
The optional SSH diagnostics/pacing tools remain opt-in source utilities; the
release does not install machine-specific gateways or transport overrides.

## Interactive terminal colors

The custom macOS launcher clears inherited `NO_COLOR` before opening the GUI.
Automation often sets this variable for its own logs; passing it to an interactive
agent can disable colors even with TERM=xterm-256color and COLORTERM=truecolor.

For local zsh terminals started through an already running app/core, run
`python3 scripts/install-interactive-colors.py`. It adds a managed block to
~/.zshrc that unsets NO_COLOR only when HC_TERMINAL_ID is present. Noninteractive
zsh invocations and shells outside Herdr retain their existing environment.
The installer preserves file permissions, keeps a first-original backup at
~/.zshrc.herdr-colors-v1.bak, and supports --remove (managed block only).

For remote Bash machines, run the same opt-in installer there with `--shell bash`.
It prepends an interactive-Herdr-only guard to `.bashrc`, before platform startup
can exec another Bash. Noninteractive commands and ordinary SSH shells keep
their original `NO_COLOR`. Startup symlinks and permissions are preserved, with
a `.herdr-colors-v1.bak` backup beside the actual startup file. The installer can
be piped through `hc exec --on <machine> --timeout 20 -i -- python3 - --shell bash`.
This handles a remote core started or updated from an automation process whose
environment included `NO_COLOR=1`; no core restart is needed for new Bash terminals.

The launcher fix applies on the next app launch; the shell guard applies to new
interactive shells immediately. Existing processes retain their original environment.
Do not stop active tasks to apply it. An approved idle Codex restart should use
`env -u NO_COLOR codex resume <exact-session-UUID>` to retain the conversation,
then verify the foreground process environment and native status. No core restart
is needed. The script is a local opt-in; packaging does not edit recipients' profiles.

## Automatic SSH port forwarding

The right-side Ports view follows the active workspace's machine. Its controller
in the tab bar keeps discovery running when the Ports view is closed. A private
Python stdlib helper owns one dedicated OpenSSH master for each machine with
active mappings; core connections and terminal processes are never reused for
tunnel lifecycle management or stopped. No native core API, Rust dependency,
remote server installation or public tunnel service is added.

Linux remote discovery reads /proc TCP listeners belonging to the live Herdr
terminal process trees of that user. It excludes agent/core/SSH transport processes
and privileged ports from automatic discovery, caps each scan at 64 listeners,
and scans only the active machine and machines with existing mappings. Manual
forwarding supports TCP ports 1–65535, including services outside terminal trees.
Discovery errors retain existing mappings. A stopped automatic port is persisted
as ignored; explicit Forward enables it again. Auto off stops automatic mappings
without removing manually requested ones. Stop all affects only this feature's
mappings on the selected machine, never remote services.

All local endpoints bind 127.0.0.1. IPv4/IPv6 remote addresses are supported.
OpenSSH reads the user's existing config, authentication and host-key policy.
Local port conflicts fall back to an ephemeral port; a remembered local address
is preferred after reconnect, including sockets in TIME_WAIT. Browser links use
HTTP; Copy address works for other TCP clients. Forwarding has the same protocol
and authentication requirements as the original service.

Preferences are per app home in port-forwarding/config.json (auto, ignored,
manual, targets and remembered local ports), written atomically with mode 0600.
The control endpoint is a private Unix socket in a short /tmp directory, with a
per-home lock; short paths avoid macOS OpenSSH's socket length limit. Discovery
uses a five-second cycle while the UI refreshes, and stops using stale root PIDs
when UI heartbeats stop. Existing SSH mappings can outlive a closed GUI.

Non-SSH `via` commands cannot supply SSH forwarding themselves. Set an explicit
SSH alias in Ports when the same machine is also reachable through SSH. For the
local user's machine 200, target 200 is configured separately; its paced core
transport remains unchanged. Initial support is macOS/Linux local clients and
Linux/Python 3 discovery; other SSH targets can use manual ports. UDP, automatic
terminal-output URL detection and public sharing are outside this implementation.

Validation includes policy/ownership tests and a real independent HTTP fixture
on 814: automatic discovery, HTTP access through SSH, a conflicting local port,
an intentionally terminated feature-owned SSH master, reconnect, and stopping a
mapping while verifying the remote fixture is still alive. Tests never type into
or restart existing user terminals.

Detached training monitors can register their existing listening PID with
`defaults/mods/ports/herdr-monitor.py request` and read actual local URLs with `links`.
See `docs/training-monitor.md` for deployment and the agent workflow. This
respects Ports Auto/Stop and does not restart training or monitoring services.

Older personal layouts without a Ports slot open the panel in a dialog when
the updated tab bar button is clicked. Their saved layout is not rewritten.
