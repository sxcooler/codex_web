#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
check_node
if [[ $# -gt 0 && $1 != --interactive ]]; then set -- --port "$@"; fi
exec "$node" "$repo/scripts/tailscale.ts" "$@"
