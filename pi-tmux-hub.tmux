#!/usr/bin/env bash

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -x "$PLUGIN_DIR/bin/pi-tmux-hub.js" ]]; then
  HUB_CMD="$(printf '%q' "$PLUGIN_DIR/bin/pi-tmux-hub.js")"
elif command -v pi-tmux-hub >/dev/null 2>&1; then
  HUB_CMD="pi-tmux-hub"
else
  exit 0
fi

tmux if -F '#{==:#{@pi_tmux_hub_key},}' 'set -g @pi_tmux_hub_key h'
KEY="$(tmux display-message -p '#{@pi_tmux_hub_key}')"
tmux bind "$KEY" run-shell "$HUB_CMD sidebar"
