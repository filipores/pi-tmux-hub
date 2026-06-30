# pi-tmux-hub tmux plugin. Load with: source-file /path/to/pi-tmux-hub.tmux

if -F '#{==:#{@pi_tmux_hub_key},}' 'set -g @pi_tmux_hub_key h'

run-shell -b 'plugin_file="#{current_file}"; plugin_dir="$(cd "$(dirname "$plugin_file")" && pwd)"; if [ -x "$plugin_dir/bin/pi-tmux-hub.js" ]; then hub_cmd="$(printf "%q" "$plugin_dir/bin/pi-tmux-hub.js")"; elif command -v pi-tmux-hub >/dev/null 2>&1; then hub_cmd="pi-tmux-hub"; elif [ -x "$HOME/bin/pi-tmux-hub" ]; then hub_cmd="$(printf "%q" "$HOME/bin/pi-tmux-hub")"; else exit 0; fi; key="$(tmux display-message -p "#{@pi_tmux_hub_key}")"; tmux bind "$key" run-shell "$hub_cmd sidebar"'
