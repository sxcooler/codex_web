#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 0 ]] || fail 'Usage: bash scripts/linux/stop-server.sh'
if command -v systemctl >/dev/null && systemctl --user is-active --quiet "$unit" 2>/dev/null; then
  [[ $(systemctl --user show "$unit" -p FragmentPath --value) == "$unit_file" ]] && grep -Fxq -- "$marker" "$unit_file" || fail 'The systemd unit belongs to another workspace.'
  systemctl --user stop "$unit"
fi
[[ -f "$data/server.pid" ]] || { printf 'No managed Web process.\n'; exit 0; }
read -r pid tick extra < "$data/server.pid"
[[ $pid =~ ^[0-9]+$ && $pid -gt 1 && $tick =~ ^[0-9]+$ && -z $extra ]] || fail 'Invalid PID record; nothing was stopped.'
[[ -d /proc/$pid ]] || { rm -- "$data/server.pid"; printf 'Web already stopped.\n'; exit 0; }
[[ -O /proc/$pid && $(start_tick "$pid") == "$tick" ]] || fail 'PID identity changed; nothing was stopped.'
mapfile -d '' -t args < "/proc/$pid/cmdline"
[[ ${#args[@]} == 2 && ${args[1]} == "$entry" && $(readlink -f "/proc/$pid/cwd") == "$repo" ]] || fail 'PID is not this workspace Web server; nothing was stopped.'
kill -TERM "$pid"
for ((i=0; i<150; i++)); do
  if [[ ! -d /proc/$pid ]] || [[ $(start_tick "$pid" || true) != "$tick" ]]; then
    rm -- "$data/server.pid"
    printf 'Stopped this workspace Web server.\n'
    exit 0
  fi
  sleep 0.1
done
fail 'Web did not exit within 15 seconds; inspect its logs. No unrelated process was killed.'
