# pi-tmux-hub

A tmux-native monitor and pane jumper for Pi coding-agent sessions.

It does not run an LLM, call the network, or try to become the agent runtime. tmux owns panes; Pi is an adapter via local session JSONL.

## Usage

```bash
pi-tmux-hub
pi-tmux-hub hub
pi-tmux-hub sidebar
pi-tmux-hub spawn "fix parser"
pi-tmux-hub close --delete-worktree --force
pi-tmux-hub --watch
pi-tmux-hub --json
pi-tmux-hub jump agents:1.0
pi-tmux-hub next
pi-tmux-hub next working
pi-tmux-hub register --state working
```

During local development:

```bash
node bin/pi-tmux-hub.js
node bin/pi-tmux-hub.js hub
node bin/pi-tmux-hub.js sidebar
node bin/pi-tmux-hub.js --watch --interval 2
```

Example output:

```text
STATE    TARGET    CMD   DIR       ADAPTER  PI NAME     LAST  AGE
waiting  work:1.0  node  repo      pi       Fix parser  stop  4m
tmux     work:1.1  zsh   scratch   tmux     -           -     -
```

## What it watches

- `tmux list-panes -a` for panes, commands, and current directories.
- `~/.pi-tmux-hub/registry` for exact pane → Pi session mappings from the Pi sensor.
- `~/.pi/agent/sessions` as a cwd-based fallback when no registry entry exists.
- `/name` / `--name` metadata when Pi has written `session_info` entries.

## Dynamic Pi sensor

Install this repo as a Pi package to load the tiny sensor extension:

```bash
pi install git:github.com/filipores/pi-tmux-hub
```

When Pi runs inside tmux, the sensor writes only local registry metadata: pane id, cwd, Pi session file, pid, state, last event/tool. It never writes prompt/code content and never calls the network.

For custom Dynamic Workflow hooks, the same registry can be updated directly:

```bash
pi-tmux-hub register --state working --pane-id "$TMUX_PANE" --session-file /path/to/session.jsonl
pi-tmux-hub register --state waiting --pane-id "$TMUX_PANE" --session-file /path/to/session.jsonl
```

## Interactive hub

Run the live selector fullscreen inside tmux:

```bash
pi-tmux-hub hub
```

Or keep it visible in a tmux side pane:

```bash
pi-tmux-hub sidebar
```

Keys:

- `j` / `↓`: select next row
- `k` / `↑`: select previous row
- `Enter`: jump to selected pane
- `n`: jump to first attention pane (`error`, then `working`, then `waiting`)
- `r`: refresh
- `q`: quit

## tmux keybinding

Load the tmux helper to bind `prefix h` to `pi-tmux-hub sidebar`:

```tmux
run-shell ~/tools/pi-tmux-hub/pi-tmux-hub.tmux
```

Override the key before loading:

```tmux
set -g @pi_tmux_hub_key H
run-shell ~/tools/pi-tmux-hub/pi-tmux-hub.tmux
```

## Worktree spawn and close

Create a short-lived worktree branch and tmux window from the current pane's git repo:

```bash
pi-tmux-hub spawn "fix parser"
```

This creates branch `agent/fix-parser`, worktree `.worktrees/fix-parser`, a tmux window named `fix-parser`, and starts `pi` there.

Close only the tmux window:

```bash
pi-tmux-hub close
```

Delete the managed worktree and branch too:

```bash
pi-tmux-hub close --delete-worktree --force
```

`close` refuses panes not created by `pi-tmux-hub spawn`.

## Navigation

Use the `TARGET` column to jump into a session:

```bash
pi-tmux-hub jump work:1.0
```

Jump to the first attention pane (`error`, then `working`, then `waiting`):

```bash
pi-tmux-hub next
```

Or filter by state, target, or Pi session name substring:

```bash
pi-tmux-hub next working
pi-tmux-hub next "Fix parser"
```

## Options

```text
hub                    Open the interactive live selector.
sidebar                Toggle hub in a tmux side pane.
spawn <name>           Create .worktrees/<name>, branch agent/<name>, tmux window.
close                  Close a pi-tmux-hub spawned window; delete only with flags.
--json                 Print machine-readable rows.
--watch                Refresh until interrupted.
--interval <seconds>   Watch refresh interval. Default: 5.
--full-paths           Show cwd and Pi session file paths. Hidden by default.
--pi-root <dir>        Pi session root. Default: ~/.pi/agent/sessions.
--registry-dir <dir>   Pi/tmux registry dir. Default: ~/.pi-tmux-hub/registry.
--tmux <binary>        tmux binary. Default: tmux.
--target <pane>        tmux target for spawn/close.
--command <cmd>        Command for spawned window. Default: pi.
--delete-worktree      With close, also remove managed worktree and branch.
--force                With --delete-worktree, force git worktree/branch removal.
-h, --help             Show help.
```

## Privacy posture

- Snapshot, hub, and sidebar display are read-only; `jump`/`next`/hub Enter only switch tmux focus.
- No network calls.
- No token usage.
- No prompt or code text is printed.
- Full local paths are hidden unless `--full-paths` is passed.
- Worktree deletion only runs for windows marked by `pi-tmux-hub spawn`.

## MVP limits

- Hub navigation plus tmux focus switching only; no `steer`, `follow_up`, or `abort` yet.
- Without the Pi sensor, Pi detection falls back to cwd + latest session JSONL.
- tmux is required.

Next useful slice: add optional manual controls for live Pi sessions.
