#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nvm_version="v0.40.3"
node_version="26"
zellij_config_file="${XDG_CONFIG_HOME:-$HOME/.config}/zellij/config.kdl"
zellij_token_database_file="${XDG_DATA_HOME:-$HOME/.local/share}/zellij/tokens.db"

host=""
listen_host="0.0.0.0"
service_port="8024"
zellij_port="8021"
viewer_port="8022"
non_interactive=false

usage() {
    cat <<'EOF'
Usage: scripts/init.sh [options]

Options:
  --host <ip-or-hostname>     Browser-facing IP address or hostname
  --service-port <port>      Terminal Web HTTPS port (default: 8024)
  --zellij-port <port>       Zellij Web HTTPS port (default: 8021)
  --viewer-port <port>       Local code-viewer port (default: 8022)
  --listen-host <address>    Terminal Web listen address (default: 0.0.0.0)
  --non-interactive          Fail instead of prompting for missing values
  -h, --help                 Show this help
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

require_value() {
    [[ $# -ge 2 && -n "$2" ]] || die "$1 requires a value"
}

validate_port() {
    local name="$1"
    local value="$2"
    [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
    (( value >= 1 && value <= 65535 )) || die "$name must be between 1 and 65535"
}

prompt_with_default() {
    local prompt="$1"
    local default_value="$2"
    local result=""
    read -r -p "$prompt [$default_value]: " result
    printf '%s' "${result:-$default_value}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)
            require_value "$1" "${2:-}"
            host="$2"
            shift 2
        ;;
        --service-port)
            require_value "$1" "${2:-}"
            service_port="$2"
            shift 2
        ;;
        --zellij-port)
            require_value "$1" "${2:-}"
            zellij_port="$2"
            shift 2
        ;;
        --viewer-port)
            require_value "$1" "${2:-}"
            viewer_port="$2"
            shift 2
        ;;
        --listen-host)
            require_value "$1" "${2:-}"
            listen_host="$2"
            shift 2
        ;;
        --non-interactive)
            non_interactive=true
            shift
        ;;
        -h|--help)
            usage
            exit 0
        ;;
        *)
            die "unknown option: $1"
        ;;
    esac
done

if [[ "$non_interactive" == false ]]; then
    [[ -n "$host" ]] || read -r -p "Browser-facing host IP or hostname: " host
    service_port="$(prompt_with_default "Terminal Web HTTPS port" "$service_port")"
    zellij_port="$(prompt_with_default "Zellij Web HTTPS port" "$zellij_port")"
    viewer_port="$(prompt_with_default "Local code-viewer port" "$viewer_port")"
fi

[[ -n "$host" ]] || die "--host is required"
[[ "$host" != "0.0.0.0" && "$host" != "::" && "$host" != "[::]" ]] || die "--host must be the address used by browsers"
[[ "$host" != *"://"* && "$host" != */* ]] || die "--host must not include a URL scheme or path"

validate_port "service port" "$service_port"
validate_port "Zellij port" "$zellij_port"
validate_port "viewer port" "$viewer_port"
[[ "$service_port" != "$zellij_port" && "$service_port" != "$viewer_port" && "$zellij_port" != "$viewer_port" ]] \
|| die "service, Zellij, and viewer ports must be different"

for command_name in curl openssl; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is not installed: $command_name"
done

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    echo "Installing nvm $nvm_version..."
    curl --fail --show-error --silent --location \
    "https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_version}/install.sh" | bash
fi

# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"
echo "Installing Node.js $node_version..."
nvm install "$node_version"
nvm use "$node_version"

HOST_VALUE="$host" node --input-type=module <<'NODE'
const host = process.env.HOST_VALUE;
try {
    const url = new URL(`https://${host}:8024`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
} catch {
    console.error('Error: --host must be a valid hostname, IPv4 address, or bracketed IPv6 address');
    process.exit(1);
}
NODE

mkdir -p -m 700 "$project_root/data" "$project_root/data/zellij/certs"
if [[ ! -s "$project_root/data/directory-id.secret" ]]; then
    umask 077
    openssl rand -base64 32 > "$project_root/data/directory-id.secret"
fi
chmod 600 "$project_root/data/directory-id.secret"

mkdir -p -m 700 "$(dirname "$zellij_config_file")" "$(dirname "$zellij_token_database_file")"
if [[ ! -f "$zellij_config_file" ]]; then
    : > "$zellij_config_file"
    chmod 600 "$zellij_config_file"
fi

certificate_file="$project_root/data/zellij/certs/cert.pem"
private_key_file="$project_root/data/zellij/certs/key.pem"

echo "Writing config.json..."
HOST_VALUE="$host" \
LISTEN_HOST_VALUE="$listen_host" \
SERVICE_PORT_VALUE="$service_port" \
ZELLIJ_PORT_VALUE="$zellij_port" \
VIEWER_PORT_VALUE="$viewer_port" \
ZELLIJ_CONFIG_VALUE="$zellij_config_file" \
ZELLIJ_TOKEN_DB_VALUE="$zellij_token_database_file" \
CERTIFICATE_FILE_VALUE="$certificate_file" \
PRIVATE_KEY_FILE_VALUE="$private_key_file" \
PROJECT_ROOT_VALUE="$project_root" \
node --input-type=module <<'NODE'
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const config = {
  listenHost: process.env.LISTEN_HOST_VALUE,
  listenPort: Number(process.env.SERVICE_PORT_VALUE),
  publicBaseUrl: `https://${process.env.HOST_VALUE}:${process.env.SERVICE_PORT_VALUE}`,
  zellijWebBaseUrl: `https://${process.env.HOST_VALUE}:${process.env.ZELLIJ_PORT_VALUE}`,
  zellij: {
    managedBinaryFile: 'data/bin/zellij',
    configFile: process.env.ZELLIJ_CONFIG_VALUE,
    webTokenDatabaseFile: process.env.ZELLIJ_TOKEN_DB_VALUE,
    webCertificateFile: process.env.CERTIFICATE_FILE_VALUE,
    webPrivateKeyFile: process.env.PRIVATE_KEY_FILE_VALUE,
  },
  directoryIdSecretFile: 'data/directory-id.secret',
  viewerPortRange: {
    start: Number(process.env.VIEWER_PORT_VALUE),
    end: Number(process.env.VIEWER_PORT_VALUE),
  },
  viewerIdleTimeoutMinutes: 60,
  viewerMaxInstances: 1,
  projectMarkers: ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml'],
  allowedSessionCommands: ['codex'],
};

const configFile = path.join(process.env.PROJECT_ROOT_VALUE, 'config.json');
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await chmod(configFile, 0o600);
NODE

echo "Updating Zellij configuration..."
ZELLIJ_CONFIG_VALUE="$zellij_config_file" \
ZELLIJ_PORT_VALUE="$zellij_port" \
CERTIFICATE_FILE_VALUE="$certificate_file" \
PRIVATE_KEY_FILE_VALUE="$private_key_file" \
node --input-type=module <<'NODE'
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';

const configFile = process.env.ZELLIJ_CONFIG_VALUE;
const originalStat = await stat(configFile);
let content = await readFile(configFile, 'utf8');
const settings = new Map([
  ['mouse_mode', 'mouse_mode true'],
  ['copy_on_select', 'copy_on_select true'],
  ['scroll_buffer_size', 'scroll_buffer_size 500000'],
  ['web_server', 'web_server true'],
  ['web_sharing', 'web_sharing "on"'],
  ['web_server_ip', 'web_server_ip "0.0.0.0"'],
  ['web_server_port', `web_server_port ${process.env.ZELLIJ_PORT_VALUE}`],
  ['web_server_cert', `web_server_cert "${process.env.CERTIFICATE_FILE_VALUE}"`],
  ['web_server_key', `web_server_key "${process.env.PRIVATE_KEY_FILE_VALUE}"`],
]);

for (const [name, replacement] of settings) {
  const activeSetting = new RegExp(`^\\s*${name}\\s+.*$`, 'gm');
  if (activeSetting.test(content)) content = content.replace(activeSetting, replacement);
  else content = `${content.replace(/\\s*$/u, '')}\n${replacement}\n`;
}

const temporaryFile = `${configFile}.tmp-${process.pid}`;
await writeFile(temporaryFile, content, { mode: originalStat.mode & 0o777 });
await rename(temporaryFile, configFile);
await chmod(configFile, originalStat.mode & 0o777);
NODE

echo "Installing project dependencies and Zellij 0.44.3..."
cd "$project_root"
npm install
npm run build

echo
echo "Configuration initialization complete."
echo "The management service was not started."
echo "The self-signed certificate and Zellij token will be created when the service is started separately."
