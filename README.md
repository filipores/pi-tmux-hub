# pi-tmux-hub

A tmux-native, read-only monitor for Pi coding-agent sessions.

It does not run an LLM, call the network, or try to become the agent runtime. tmux owns panes; Pi is an adapter via local session JSONL.

## Usage

```bash
pi-tmux-hub
pi-tmux-hub --watch
pi-tmux-hub --json
```

During local development:

```bash
node bin/pi-tmux-hub.js
node bin/pi-tmux-hub.js --watch --interval 2
```

Example output:

```text
STATE    TARGET    CMD   DIR       ADAPTER  PI NAME     AGE
waiting  work:1.0  node  repo      pi       Fix parser  4m
tmux     work:1.1  zsh   scratch   tmux     -           -
```

## What it watches

- `tmux list-panes -a` for panes, commands, and current directories.
- `~/.pi/agent/sessions` for the latest Pi JSONL session matching a pane cwd.
- `/name` / `--name` metadata when Pi has written `session_info` entries.

## Options

```text
--json                 Print machine-readable rows.
--watch                Refresh until interrupted.
--interval <seconds>   Watch refresh interval. Default: 5.
--full-paths           Show cwd and Pi session file paths. Hidden by default.
--pi-root <dir>        Pi session root. Default: ~/.pi/agent/sessions.
--tmux <binary>        tmux binary. Default: tmux.
-h, --help             Show help.
```

## Privacy posture

- Read-only by default.
- No network calls.
- No token usage.
- No prompt or code text is printed.
- Full local paths are hidden unless `--full-paths` is passed.

## MVP limits

- Snapshot/watch only; no `steer`, `follow_up`, `abort`, or pane control yet.
- Pi detection is cwd + latest session JSONL, not RPC live state.
- tmux is required.

Next useful slice: add optional RPC-backed sessions for exact live state and manual controls.
