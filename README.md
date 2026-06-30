# pi-tmux-hub

A tmux-native monitor and pane jumper for Pi coding-agent sessions.

It does not run an LLM, call the network, or try to become the agent runtime. tmux owns panes; Pi is an adapter via local session JSONL.

## Usage

```bash
pi-tmux-hub
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
--json                 Print machine-readable rows.
--watch                Refresh until interrupted.
--interval <seconds>   Watch refresh interval. Default: 5.
--full-paths           Show cwd and Pi session file paths. Hidden by default.
--pi-root <dir>        Pi session root. Default: ~/.pi/agent/sessions.
--registry-dir <dir>   Pi/tmux registry dir. Default: ~/.pi-tmux-hub/registry.
--tmux <binary>        tmux binary. Default: tmux.
-h, --help             Show help.
```

## Privacy posture

- Snapshot mode is read-only; `jump`/`next` only switch tmux focus.
- No network calls.
- No token usage.
- No prompt or code text is printed.
- Full local paths are hidden unless `--full-paths` is passed.

## MVP limits

- Snapshot/watch plus tmux focus switching only; no `steer`, `follow_up`, or `abort` yet.
- Without the Pi sensor, Pi detection falls back to cwd + latest session JSONL.
- tmux is required.

Next useful slice: add optional manual controls for live Pi sessions.
