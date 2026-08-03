#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pid_file="$project_root/data/terminal-web.pid"
graceful_stop_steps=100
progress_width=20

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
    echo "Terminal Web is not running (PID file not found)"
    exit 0
fi

service_pid="$(<"$pid_file")"
if [[ ! "$service_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid Terminal Web PID file" >&2
    exit 1
fi

if ! kill -0 "$service_pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "Removed stale Terminal Web PID file"
    exit 0
fi

command_line="$(tr '\0' ' ' < "/proc/$service_pid/cmdline" 2>/dev/null || true)"
if [[ "$command_line" != *"$project_root/dist/server.js"* ]]; then
    echo "PID $service_pid does not belong to this Terminal Web service" >&2
    exit 1
fi

echo "Sending SIGTERM to Terminal Web (PID $service_pid)"
kill -TERM "$service_pid"
print_stop_progress 0
for ((step = 1; step <= graceful_stop_steps; step += 1)); do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        finish_stop_progress "$step" "completed"
        rm -f "$pid_file"
        echo "Terminal Web stopped"
        exit 0
    fi
    sleep 0.1
    print_stop_progress "$step"
done

if ! kill -0 "$service_pid" 2>/dev/null; then
    finish_stop_progress "$graceful_stop_steps" "completed"
    rm -f "$pid_file"
    echo "Terminal Web stopped"
    exit 0
fi

finish_stop_progress "$graceful_stop_steps" "timed out"
echo "Sending SIGKILL to Terminal Web (PID $service_pid)" >&2
kill -KILL "$service_pid" 2>/dev/null || true
rm -f "$pid_file"
echo "Terminal Web did not stop within 10 seconds and was killed" >&2
