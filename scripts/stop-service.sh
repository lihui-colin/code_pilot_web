#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pid_file="$project_root/data/codepilot-web.pid"
runtime_file="$project_root/data/service-runtime.json"
graceful_stop_steps=100
progress_width=20

cleanup_support_services() {
    if [[ ! -f "$runtime_file" ]]; then
        echo "CodePilot Web runtime metadata was not found; support services were not cleaned" >&2
        return 1
    fi
    mapfile -t runtime_values < <(node --input-type=module - "$runtime_file" <<'NODE'
import { readFileSync } from 'node:fs';
const runtime = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (typeof runtime.configFile !== 'string' || typeof runtime.workspaceRoot !== 'string') process.exit(1);
process.stdout.write(`${runtime.configFile}\n${runtime.workspaceRoot}\n`);
NODE
    )
    if [[ ${#runtime_values[@]} -ne 2 ]]; then
        echo "Invalid CodePilot Web runtime metadata" >&2
        return 1
    fi
    echo "Stopping Zellij Web, code-viewer, OpenVSCode, and remaining managed services"
    node "$project_root/scripts/service-runtime.mjs" cleanup "${runtime_values[0]}" "${runtime_values[1]}"
    rm -f "$runtime_file"
    echo "CodePilot Web support services stopped"
}

backfill_runtime_metadata() {
    local service_pid="$1"
    [[ -f "$runtime_file" ]] && return
    local temporary_runtime_file="$runtime_file.tmp-$$"
    if node --input-type=module - "$service_pid" > "$temporary_runtime_file" <<'NODE'
import { readFileSync } from 'node:fs';
const pid = process.argv[2];
const arguments_ = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
const option = name => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};
const configFile = option('--config');
const workspaceRoot = option('--workspace-root');
if (!configFile || !workspaceRoot) process.exit(1);
process.stdout.write(`${JSON.stringify({ configFile, workspaceRoot }, null, 2)}\n`);
NODE
    then
        chmod 600 "$temporary_runtime_file"
        mv "$temporary_runtime_file" "$runtime_file"
    else
        rm -f "$temporary_runtime_file"
    fi
}

print_stop_progress() {
    local step="$1"
    local percent=$((step * 100 / graceful_stop_steps))
    local elapsed_seconds=$((step / 10))
    local elapsed_tenths=$((step % 10))

    if [[ -t 1 ]]; then
        local filled=$((percent * progress_width / 100))
        local empty=$((progress_width - filled))
        local filled_bar=""
        local empty_bar=""
        printf -v filled_bar '%*s' "$filled" ''
        printf -v empty_bar '%*s' "$empty" ''
        filled_bar="${filled_bar// /#}"
        empty_bar="${empty_bar// /-}"
        printf '\rWaiting for graceful shutdown [%s%s] %3d%% (%d.%ds/10.0s)' \
            "$filled_bar" "$empty_bar" "$percent" "$elapsed_seconds" "$elapsed_tenths"
    elif (( step % 10 == 0 )); then
        printf 'Waiting for graceful shutdown: %3d%% (%d.%ds/10.0s)\n' \
            "$percent" "$elapsed_seconds" "$elapsed_tenths"
    fi
}

finish_stop_progress() {
    local step="$1"
    local result="$2"
    local elapsed_seconds=$((step / 10))
    local elapsed_tenths=$((step % 10))

    if [[ -t 1 ]]; then
        printf '\r%-79s\r' ''
    fi
    printf 'Graceful shutdown %s after %d.%ds\n' "$result" "$elapsed_seconds" "$elapsed_tenths"
}

if [[ ! -f "$pid_file" ]]; then
    echo "CodePilot Web is not running (PID file not found)"
    cleanup_support_services
    exit 0
fi

service_pid="$(<"$pid_file")"
if [[ ! "$service_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid CodePilot Web PID file" >&2
    exit 1
fi

if ! kill -0 "$service_pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "Removed stale CodePilot Web PID file"
    cleanup_support_services
    exit 0
fi

command_line="$(tr '\0' ' ' < "/proc/$service_pid/cmdline" 2>/dev/null || true)"
if [[ "$command_line" != *"$project_root/dist/server.js"* ]]; then
    echo "PID $service_pid does not belong to this CodePilot Web service" >&2
    exit 1
fi

backfill_runtime_metadata "$service_pid"

echo "Sending SIGTERM to CodePilot Web (PID $service_pid)"
kill -TERM "$service_pid"
print_stop_progress 0
for ((step = 1; step <= graceful_stop_steps; step += 1)); do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        finish_stop_progress "$step" "completed"
        rm -f "$pid_file"
        cleanup_support_services
        echo "CodePilot Web stopped"
        exit 0
    fi
    sleep 0.1
    print_stop_progress "$step"
done

if ! kill -0 "$service_pid" 2>/dev/null; then
    finish_stop_progress "$graceful_stop_steps" "completed"
    rm -f "$pid_file"
    cleanup_support_services
    echo "CodePilot Web stopped"
    exit 0
fi

finish_stop_progress "$graceful_stop_steps" "timed out"
echo "Sending SIGKILL to CodePilot Web (PID $service_pid)" >&2
kill -KILL "$service_pid" 2>/dev/null || true
rm -f "$pid_file"
cleanup_support_services
echo "CodePilot Web did not stop within 10 seconds and was killed" >&2
