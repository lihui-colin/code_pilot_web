#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="${2:-$project_root/config.json}"
pid_file="$project_root/data/codepilot-web.pid"
runtime_file="$project_root/data/service-runtime.json"
log_file="$project_root/data/codepilot-web.log"

print_started() {
    echo "CodePilot Web started with PID $service_pid"
    echo "Access URL: $access_url"
    echo "Workspace: $workspace_root"
    echo "Log: $log_file"
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo "Usage: $0 <workspace-root> [config-file]" >&2
    exit 2
fi

config_file="$(realpath "$config_file")"

access_url="$(node --input-type=module - "$config_file" <<'NODE'
import { readFileSync } from 'node:fs';
import net from 'node:net';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ports = [
    { name: 'CodePilot Web', host: config.listenHost, port: config.listenPort },
    { name: 'code-viewer', host: '127.0.0.1', port: config.viewerPortRange.start },
];

if (config.viewerPortRange.end !== config.viewerPortRange.start) {
    for (let port = config.viewerPortRange.start + 1; port <= config.viewerPortRange.end; port += 1) {
        ports.push({ name: 'code-viewer', host: '127.0.0.1', port });
    }
}

for (const candidate of ports) {
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', error => {
            if (error.code === 'EADDRINUSE') {
                reject(new Error(`${candidate.name} port is already in use: ${candidate.host}:${candidate.port}`));
            } else {
                reject(new Error(`Unable to check ${candidate.name} port ${candidate.host}:${candidate.port}: ${error.message}`));
            }
        });
        server.listen({ host: candidate.host, port: candidate.port, exclusive: true }, () => {
            server.close(resolve);
        });
    }).catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}

process.stdout.write(`${config.publicBaseUrl}\n`);
NODE
)"

if [[ -z "$access_url" ]]; then
    echo "Unable to determine CodePilot Web access URL" >&2
    exit 1
fi

workspace_root="$(realpath "$1")"
if [[ ! -d "$workspace_root" || ! -r "$workspace_root" ]]; then
    echo "Workspace root must be an existing readable directory: $workspace_root" >&2
    exit 2
fi

node "$project_root/scripts/service-runtime.mjs" ensure-support "$config_file" "$workspace_root"

if [[ -f "$pid_file" ]]; then
    existing_pid="$(<"$pid_file")"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
        command_line="$(tr '\0' ' ' < "/proc/$existing_pid/cmdline" 2>/dev/null || true)"
        if [[ "$command_line" == *"$project_root/dist/server.js"* ]]; then
            echo "CodePilot Web is already running with PID $existing_pid" >&2
        else
            echo "PID file points to another running process: $existing_pid" >&2
        fi
        exit 1
    fi
    rm -f "$pid_file"
fi

cd "$project_root"
npm run build
mkdir -p -m 700 data
temporary_runtime_file="$runtime_file.tmp-$$"
node --input-type=module - "$config_file" "$workspace_root" > "$temporary_runtime_file" <<'NODE'
const [configFile, workspaceRoot] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ configFile, workspaceRoot }, null, 2)}\n`);
NODE
chmod 600 "$temporary_runtime_file"
mv "$temporary_runtime_file" "$runtime_file"
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

for _ in {1..100}; do
    if ! kill -0 "$service_pid" 2>/dev/null; then
        rm -f "$pid_file"
        rm -f "$runtime_file"
        echo "CodePilot Web failed to start. Recent log output:" >&2
        tail -n 20 "$log_file" >&2
        exit 1
    fi
    if grep -q 'Server listening at' "$log_file"; then
        print_started
        exit 0
    fi
    sleep 0.1
done

echo "CodePilot Web is still starting with PID $service_pid"
echo "Log: $log_file"
