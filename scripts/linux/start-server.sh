#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 0 ]] || fail 'Usage: bash scripts/linux/start-server.sh'
check_node
check_ready
command -v flock >/dev/null || fail 'Install util-linux (flock) first.'
exec 9>"$data/server.lock"
flock -n 9 || fail 'This workspace already has a running Web server.'
printf '%s %s\n' "$$" "$(start_tick "$$")" > "$data/server.pid"
cd -- "$repo"
# Replace the shell: signals reach Node directly; only this process holds the lock.
exec "$node" "$entry"
