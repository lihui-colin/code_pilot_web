#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pid_file="$project_root/data/terminal-web.pid"

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

kill -TERM "$service_pid"
for _ in {1..100}; do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        rm -f "$pid_file"
        echo "Terminal Web stopped"
        exit 0
    fi
    sleep 0.1
done

kill -KILL "$service_pid"
rm -f "$pid_file"
echo "Terminal Web did not stop within 10 seconds and was killed" >&2
