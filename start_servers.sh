#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="${1:-$project_root}"

exec "$project_root/scripts/start-service.sh" "$workspace_root" "${2:-$project_root/config.json}"
exec "$project_root/scripts/start-service.sh" "$workspace_root" "${2:-$project_root/config.json}"
