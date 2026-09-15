#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
check_node
"$node" "$repo/scripts/server-control.ts" --status
if command -v systemctl >/dev/null; then systemctl --user status "$unit" --no-pager 2>/dev/null || true; fi
