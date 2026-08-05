#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="${2:-$project_root/config.json}"
restart_delay_ms="${CODEPILOT_WEB_RESTART_DELAY_MS:-0}"

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "Usage: $0 <workspace-root> [config-file]" >&2
    exit 2
fi
if [[ ! "$restart_delay_ms" =~ ^[0-9]+$ || "$restart_delay_ms" -gt 10000 ]]; then
    echo "CODEPILOT_WEB_RESTART_DELAY_MS must be an integer from 0 to 10000" >&2
    exit 2
fi

workspace_root="$(realpath "$1")"
config_file="$(realpath "$config_file")"
if [[ ! -d "$workspace_root" || ! -r "$workspace_root" ]]; then
    echo "Workspace root must be an existing readable directory: $workspace_root" >&2
    exit 2
fi

if (( restart_delay_ms > 0 )); then
    sleep "$(printf '%d.%03d' "$((restart_delay_ms / 1000))" "$((restart_delay_ms % 1000))")"
fi

echo "[$(date -Iseconds)] Restarting CodePilot Web support services"
"$project_root/scripts/stop-service.sh"

if ! node "$project_root/scripts/service-runtime.mjs" start-support "$config_file" "$workspace_root"; then
    node "$project_root/scripts/service-runtime.mjs" cleanup "$config_file" "$workspace_root" || true
    exit 1
fi

if ! "$project_root/scripts/start-service.sh" "$workspace_root" "$config_file"; then
    node "$project_root/scripts/service-runtime.mjs" cleanup "$config_file" "$workspace_root" || true
    exit 1
fi
echo "[$(date -Iseconds)] CodePilot Web support services restarted"
