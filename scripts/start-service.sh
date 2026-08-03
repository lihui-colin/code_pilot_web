#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="$project_root/config.json"
pid_file="$project_root/data/terminal-web.pid"
log_file="$project_root/data/terminal-web.log"

print_started() {
    echo "Terminal Web started with PID $service_pid"
    echo "Access URL: $access_url"
    echo "Workspace: $workspace_root"
    echo "Log: $log_file"
}

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <workspace-root>" >&2
    exit 2
fi

workspace_root="$(realpath "$1")"
if [[ ! -d "$workspace_root" || ! -r "$workspace_root" ]]; then
    echo "Workspace root must be an existing readable directory: $workspace_root" >&2
    exit 2
fi

if [[ -f "$pid_file" ]]; then
    existing_pid="$(<"$pid_file")"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
        command_line="$(tr '\0' ' ' < "/proc/$existing_pid/cmdline" 2>/dev/null || true)"
        if [[ "$command_line" == *"$project_root/dist/server.js"* ]]; then
            echo "Terminal Web is already running with PID $existing_pid" >&2
        else
            echo "PID file points to another running process: $existing_pid" >&2
        fi
        exit 1
    fi
    rm -f "$pid_file"
fi

service_config="$(node -p "const config = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); [config.listenHost, config.listenPort, config.publicBaseUrl].join('\\t')" "$config_file")"
IFS=$'\t' read -r listen_host listen_port access_url <<< "$service_config"

node --input-type=module - "$listen_host" "$listen_port" <<'NODE'
import net from 'node:net';

const host = process.argv[2];
const port = Number(process.argv[3]);
const server = net.createServer();

server.once('error', error => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Terminal Web port is already in use: ${host}:${port}`);
    } else {
        console.error(`Unable to check Terminal Web port ${host}:${port}: ${error.message}`);
    }
    process.exitCode = 1;
});
server.listen({ host, port, exclusive: true }, () => server.close());
NODE

cd "$project_root"
npm run build
mkdir -p -m 700 data
: > "$log_file"
chmod 600 "$log_file"

nohup node "$project_root/dist/server.js" \
--config "$config_file" \
--workspace-root "$workspace_root" \
>> "$log_file" 2>&1 &
service_pid=$!

temporary_pid_file="$pid_file.tmp-$$"
printf '%s\n' "$service_pid" > "$temporary_pid_file"
chmod 600 "$temporary_pid_file"
mv "$temporary_pid_file" "$pid_file"

for _ in {1..50}; do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        rm -f "$pid_file"
        echo "Terminal Web failed to start. Recent log output:" >&2
        tail -n 20 "$log_file" >&2
        exit 1
    fi
    if grep -q 'Server listening at' "$log_file"; then
        print_started
        exit 0
    fi
    sleep 0.1
done

echo "Terminal Web is still starting with PID $service_pid"
echo "Log: $log_file"
mv "$temporary_pid_file" "$pid_file"

for _ in {1..50}; do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        rm -f "$pid_file"
        echo "Terminal Web failed to start. Recent log output:" >&2
        tail -n 20 "$log_file" >&2
        exit 1
    fi
    if grep -q 'Server listening at' "$log_file"; then
        print_started
        exit 0
    fi
    sleep 0.1
done

echo "Terminal Web is still starting with PID $service_pid"
echo "Log: $log_file"
