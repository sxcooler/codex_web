#!/usr/bin/env bash
# Shared paths and process identity for the Linux deployment entry points.
set -euo pipefail
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail 'These scripts require Linux.'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ $repo != *$'\n'* && $repo != *$'\r'* ]] || fail 'Workspace path must not contain newlines.'
data="$repo/.local/web"
entry="$repo/src/server/main.ts"
export WEB_DATA_DIR="$data"
unit="codex-web-$(printf '%s' "$repo" | sha256sum | cut -c1-12).service"
unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
marker="# Codex Web workspace: $repo"
umask 077
check_node() {
  node=$(command -v node) || fail 'Install Linux Node >=24.20.0 first.'
  "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(process.platform!=="linux"||a<24||(a===24&&b<20))process.exit(1)' || fail 'Use Linux Node >=24.20.0.'
}
check_ready() {
  [[ -f "$data/auth.json" ]] || fail 'Run npm run auth:setup first.'
  [[ -f "$repo/dist/index.html" ]] || fail 'Run npm run build first.'
}
start_tick() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  read -ra fields <<< "$rest"
  printf '%s' "${fields[19]}"
}
