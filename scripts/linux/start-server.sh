#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
background=false
diagnostic_args=()
for arg in "$@"; do
  case "$arg" in
    --background) background=true ;;
    --diagnostics) diagnostic_args=(--diagnostics) ;;
    *) fail 'Usage: bash scripts/linux/start-server.sh [--background] [--diagnostics]' ;;
  esac
done
check_node
check_ready
if $background; then
  args=(--background "${diagnostic_args[@]}")
  [[ ! -x "$repo/runtime/node" ]] || args+=(--portable)
  exec "$node" "$repo/scripts/server-control.ts" "${args[@]}"
fi
command -v flock >/dev/null || fail 'Install util-linux (flock) first.'
exec 9>"$data/server.lock"
flock -n 9 || fail 'This workspace already has a running Web server.'
printf '%s %s\n' "$$" "$(start_tick "$$")" > "$data/server.pid"
cd -- "$repo"
# Replace the shell: signals reach Node directly; only this process holds the lock.
exec "$node" "$entry" "${diagnostic_args[@]}"
