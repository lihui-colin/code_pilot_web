#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
nvm_version="v0.40.3"
node_version="26"
zellij_config_file="${XDG_CONFIG_HOME:-$HOME/.config}/zellij/config.kdl"
zellij_token_database_file="${XDG_DATA_HOME:-$HOME/.local/share}/zellij/tokens.db"

host=""
listen_host="0.0.0.0"
service_port="8020"
zellij_port="5021"
viewer_port="5022"
openvscode_port="5023"
non_interactive=false
managed_zellij_file="$HOME/.local/bin/zellij"
project_zellij_file="$project_root/data/bin/zellij"
openvscode_executable_file="$project_root/data/openvscode/current/bin/openvscode-server"

usage() {
    cat <<'EOF'
Usage: scripts/init.sh [options]

Options:
  --host <ip-or-hostname>     Browser-facing IP address or hostname
    --service-port <port>      CodePilot Web HTTPS port (default: 8020)
  --zellij-port <port>       Zellij Web HTTPS port (default: 8021)
  --viewer-port <port>       Local code-viewer port (default: 8022)
  --openvscode-port <port>   Local OpenVSCode upstream port (default: 8023)
    --listen-host <address>    CodePilot Web listen address (default: 0.0.0.0)
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
        --openvscode-port)
            require_value "$1" "${2:-}"
            openvscode_port="$2"
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
    service_port="$(prompt_with_default "CodePilot Web HTTPS port" "$service_port")"
    zellij_port="$(prompt_with_default "Zellij Web HTTPS port" "$zellij_port")"
    viewer_port="$(prompt_with_default "Local code-viewer port" "$viewer_port")"
    openvscode_port="$(prompt_with_default "Local OpenVSCode upstream port" "$openvscode_port")"
fi

[[ -n "$host" ]] || die "--host is required"
[[ "$host" != "0.0.0.0" && "$host" != "::" && "$host" != "[::]" ]] || die "--host must be the address used by browsers"
[[ "$host" != *"://"* && "$host" != */* ]] || die "--host must not include a URL scheme or path"

validate_port "service port" "$service_port"
validate_port "Zellij port" "$zellij_port"
validate_port "viewer port" "$viewer_port"
validate_port "OpenVSCode port" "$openvscode_port"
[[ "$service_port" != "$zellij_port" \
        && "$service_port" != "$viewer_port" \
        && "$service_port" != "$openvscode_port" \
        && "$zellij_port" != "$viewer_port" \
        && "$zellij_port" != "$openvscode_port" \
&& "$viewer_port" != "$openvscode_port" ]] \
|| die "service, Zellij, viewer, and OpenVSCode ports must be different"

local_zellij_version=""
project_zellij_version=""
system_zellij_version=""
system_zellij_file=""
if [[ -x "$managed_zellij_file" ]]; then
    local_zellij_version="$($managed_zellij_file --version 2>/dev/null || true)"
fi
if [[ -x "$project_zellij_file" ]]; then
    project_zellij_version="$($project_zellij_file --version 2>/dev/null || true)"
fi
if command -v zellij >/dev/null 2>&1; then
    system_zellij_file="$(command -v zellij)"
    system_zellij_version="$(zellij --version 2>/dev/null || true)"
fi
if [[ "$local_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$HOME/.local/bin/zellij"
    elif [[ "$project_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$project_zellij_file"
    elif [[ "$system_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$system_zellij_file"
else
    if [[ -n "$local_zellij_version" || -n "$project_zellij_version" || -n "$system_zellij_version" ]]; then
        die "Zellij was found with the wrong version; remove it explicitly, then run scripts/download-zellij.sh"
    fi
    echo "Zellij 0.44.3 has not been pre-downloaded."
    echo "For slow GitHub connections, stop now and run: scripts/download-zellij.sh"
    if [[ "$non_interactive" == false ]]; then
        read -r -p "Continue and let npm install download Zellij? [y/N]: " continue_install
        [[ "$continue_install" =~ ^[Yy]$ ]] || exit 0
    fi
fi

for command_name in curl openssl; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is not installed: $command_name"
done

mkdir -p -m 700 "$project_root/data" "$project_root/data/zellij/certs"
certificate_file="$project_root/data/zellij/certs/cert.pem"
private_key_file="$project_root/data/zellij/certs/key.pem"

if [[ -e "$certificate_file" || -e "$private_key_file" ]]; then
    [[ -f "$certificate_file" && -s "$certificate_file" && -f "$private_key_file" && -s "$private_key_file" ]] \
    || die "Zellij Web certificate and private key must either both be non-empty files or both be absent"
    [[ "$(stat -c '%a' "$private_key_file")" == "600" ]] || die "Zellij Web private key permissions must be 0600"
    openssl x509 -in "$certificate_file" -noout -checkend 0 >/dev/null \
    || die "Zellij Web certificate is invalid or expired"
    certificate_host="${host#[}"
    certificate_host="${certificate_host%]}"
    if [[ "$certificate_host" == *:* || "$certificate_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        openssl x509 -in "$certificate_file" -noout -checkip "$certificate_host" >/dev/null \
        || die "Zellij Web certificate does not cover $certificate_host"
    else
        openssl x509 -in "$certificate_file" -noout -checkhost "$certificate_host" >/dev/null \
        || die "Zellij Web certificate does not cover $certificate_host"
    fi
    certificate_public_key="$(openssl x509 -in "$certificate_file" -pubkey -noout)"
    private_public_key="$(openssl pkey -in "$private_key_file" -pubout)"
    [[ "$certificate_public_key" == "$private_public_key" ]] \
    || die "Zellij Web certificate and private key do not match"
else
    echo "Creating Zellij Web certificate..."
    certificate_host="${host#[}"
    certificate_host="${certificate_host%]}"
    if [[ "$certificate_host" == *:* ]]; then
        host_san="IP:$certificate_host"
        elif [[ "$certificate_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        host_san="IP:$certificate_host"
    else
        host_san="DNS:$certificate_host"
    fi
    certificate_temporary_directory="$(mktemp -d "$project_root/data/zellij/certs/.init-certificate-XXXXXX")"
    trap 'rm -rf "$certificate_temporary_directory"' EXIT
    temporary_certificate="$certificate_temporary_directory/cert.pem"
    temporary_private_key="$certificate_temporary_directory/key.pem"
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$temporary_private_key" \
    -out "$temporary_certificate" \
    -subj '/CN=CodePilot Web Zellij' \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,$host_san"
    chmod 644 "$temporary_certificate"
    chmod 600 "$temporary_private_key"
    mv "$temporary_private_key" "$private_key_file"
    mv "$temporary_certificate" "$certificate_file"
    rm -rf "$certificate_temporary_directory"
    trap - EXIT
fi

echo "Installing OpenVSCode Server 1.109.5..."
"$project_root/scripts/download-openvscode.sh"
[[ -x "$openvscode_executable_file" ]] || die "OpenVSCode executable was not installed"

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

HOST_VALUE="$host" SERVICE_PORT_VALUE="$service_port" node --input-type=module <<'NODE'
const host = process.env.HOST_VALUE;
const servicePort = process.env.SERVICE_PORT_VALUE;
try {
    const url = new URL(`https://${host}:${servicePort}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
} catch {
    console.error('Error: --host must be a valid hostname, IPv4 address, or bracketed IPv6 address');
    process.exit(1);
}
NODE

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

echo "Writing config.json..."
HOST_VALUE="$host" \
LISTEN_HOST_VALUE="$listen_host" \
SERVICE_PORT_VALUE="$service_port" \
ZELLIJ_PORT_VALUE="$zellij_port" \
VIEWER_PORT_VALUE="$viewer_port" \
OPENVSCODE_PORT_VALUE="$openvscode_port" \
OPENVSCODE_EXECUTABLE_VALUE="$openvscode_executable_file" \
ZELLIJ_CONFIG_VALUE="$zellij_config_file" \
ZELLIJ_TOKEN_DB_VALUE="$zellij_token_database_file" \
ZELLIJ_BINARY_VALUE="$managed_zellij_file" \
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
  zellij: {
        webPort: Number(process.env.ZELLIJ_PORT_VALUE),
        managedBinaryFile: process.env.ZELLIJ_BINARY_VALUE,
    configFile: process.env.ZELLIJ_CONFIG_VALUE,
    webTokenDatabaseFile: process.env.ZELLIJ_TOKEN_DB_VALUE,
    webCertificateFile: process.env.CERTIFICATE_FILE_VALUE,
    webPrivateKeyFile: process.env.PRIVATE_KEY_FILE_VALUE,
  },
    openVSCode: {
    executableFile: process.env.OPENVSCODE_EXECUTABLE_VALUE,
    port: Number(process.env.OPENVSCODE_PORT_VALUE),
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
    ['show_startup_tips', 'show_startup_tips false'],
    ['show_release_notes', 'show_release_notes false'],
    ['web_server_ip', 'web_server_ip "127.0.0.1"'],
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
echo "The management service and OpenVSCode Server were not started."
echo "OpenVSCode executable: $openvscode_executable_file"
echo "OpenVSCode localhost upstream port: $openvscode_port"
echo "The self-signed certificate and Zellij token will be created when the service is started separately."

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
        --openvscode-port)
            require_value "$1" "${2:-}"
            openvscode_port="$2"
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
    service_port="$(prompt_with_default "CodePilot Web HTTPS port" "$service_port")"
    zellij_port="$(prompt_with_default "Zellij Web HTTPS port" "$zellij_port")"
    viewer_port="$(prompt_with_default "Local code-viewer port" "$viewer_port")"
    openvscode_port="$(prompt_with_default "Local OpenVSCode upstream port" "$openvscode_port")"
fi

[[ -n "$host" ]] || die "--host is required"
[[ "$host" != "0.0.0.0" && "$host" != "::" && "$host" != "[::]" ]] || die "--host must be the address used by browsers"
[[ "$host" != *"://"* && "$host" != */* ]] || die "--host must not include a URL scheme or path"

validate_port "service port" "$service_port"
validate_port "Zellij port" "$zellij_port"
validate_port "viewer port" "$viewer_port"
validate_port "OpenVSCode port" "$openvscode_port"
[[ "$service_port" != "$zellij_port" \
        && "$service_port" != "$viewer_port" \
        && "$service_port" != "$openvscode_port" \
        && "$zellij_port" != "$viewer_port" \
        && "$zellij_port" != "$openvscode_port" \
&& "$viewer_port" != "$openvscode_port" ]] \
|| die "service, Zellij, viewer, and OpenVSCode ports must be different"

local_zellij_version=""
project_zellij_version=""
system_zellij_version=""
system_zellij_file=""
if [[ -x "$managed_zellij_file" ]]; then
    local_zellij_version="$($managed_zellij_file --version 2>/dev/null || true)"
fi
if [[ -x "$project_zellij_file" ]]; then
    project_zellij_version="$($project_zellij_file --version 2>/dev/null || true)"
fi
if command -v zellij >/dev/null 2>&1; then
    system_zellij_file="$(command -v zellij)"
    system_zellij_version="$(zellij --version 2>/dev/null || true)"
fi
if [[ "$local_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$HOME/.local/bin/zellij"
    elif [[ "$project_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$project_zellij_file"
    elif [[ "$system_zellij_version" == "zellij 0.44.3" ]]; then
    managed_zellij_file="$system_zellij_file"
else
    if [[ -n "$local_zellij_version" || -n "$project_zellij_version" || -n "$system_zellij_version" ]]; then
        die "Zellij was found with the wrong version; remove it explicitly, then run scripts/download-zellij.sh"
    fi
    echo "Zellij 0.44.3 has not been pre-downloaded."
    echo "For slow GitHub connections, stop now and run: scripts/download-zellij.sh"
    if [[ "$non_interactive" == false ]]; then
        read -r -p "Continue and let npm install download Zellij? [y/N]: " continue_install
        [[ "$continue_install" =~ ^[Yy]$ ]] || exit 0
    fi
fi

for command_name in curl openssl; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is not installed: $command_name"
done

mkdir -p -m 700 "$project_root/data" "$project_root/data/zellij/certs"
certificate_file="$project_root/data/zellij/certs/cert.pem"
private_key_file="$project_root/data/zellij/certs/key.pem"

if [[ -e "$certificate_file" || -e "$private_key_file" ]]; then
    [[ -f "$certificate_file" && -s "$certificate_file" && -f "$private_key_file" && -s "$private_key_file" ]] \
    || die "Zellij Web certificate and private key must either both be non-empty files or both be absent"
    [[ "$(stat -c '%a' "$private_key_file")" == "600" ]] || die "Zellij Web private key permissions must be 0600"
    openssl x509 -in "$certificate_file" -noout -checkend 0 >/dev/null \
    || die "Zellij Web certificate is invalid or expired"
    certificate_host="${host#[}"
    certificate_host="${certificate_host%]}"
    if [[ "$certificate_host" == *:* || "$certificate_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        openssl x509 -in "$certificate_file" -noout -checkip "$certificate_host" >/dev/null \
        || die "Zellij Web certificate does not cover $certificate_host"
    else
        openssl x509 -in "$certificate_file" -noout -checkhost "$certificate_host" >/dev/null \
        || die "Zellij Web certificate does not cover $certificate_host"
    fi
    certificate_public_key="$(openssl x509 -in "$certificate_file" -pubkey -noout)"
    private_public_key="$(openssl pkey -in "$private_key_file" -pubout)"
    [[ "$certificate_public_key" == "$private_public_key" ]] \
    || die "Zellij Web certificate and private key do not match"
else
    echo "Creating Zellij Web certificate..."
    certificate_host="${host#[}"
    certificate_host="${certificate_host%]}"
    if [[ "$certificate_host" == *:* ]]; then
        host_san="IP:$certificate_host"
        elif [[ "$certificate_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        host_san="IP:$certificate_host"
    else
        host_san="DNS:$certificate_host"
    fi
    certificate_temporary_directory="$(mktemp -d "$project_root/data/zellij/certs/.init-certificate-XXXXXX")"
    trap 'rm -rf "$certificate_temporary_directory"' EXIT
    temporary_certificate="$certificate_temporary_directory/cert.pem"
    temporary_private_key="$certificate_temporary_directory/key.pem"
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$temporary_private_key" \
    -out "$temporary_certificate" \
    -subj '/CN=CodePilot Web Zellij' \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,$host_san"
    chmod 644 "$temporary_certificate"
    chmod 600 "$temporary_private_key"
    mv "$temporary_private_key" "$private_key_file"
    mv "$temporary_certificate" "$certificate_file"
    rm -rf "$certificate_temporary_directory"
    trap - EXIT
fi

echo "Installing OpenVSCode Server 1.109.5..."
"$project_root/scripts/download-openvscode.sh"
[[ -x "$openvscode_executable_file" ]] || die "OpenVSCode executable was not installed"

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

HOST_VALUE="$host" SERVICE_PORT_VALUE="$service_port" node --input-type=module <<'NODE'
const host = process.env.HOST_VALUE;
const servicePort = process.env.SERVICE_PORT_VALUE;
try {
    const url = new URL(`https://${host}:${servicePort}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
} catch {
    console.error('Error: --host must be a valid hostname, IPv4 address, or bracketed IPv6 address');
    process.exit(1);
}
NODE

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

echo "Writing config.json..."
HOST_VALUE="$host" \
LISTEN_HOST_VALUE="$listen_host" \
SERVICE_PORT_VALUE="$service_port" \
ZELLIJ_PORT_VALUE="$zellij_port" \
VIEWER_PORT_VALUE="$viewer_port" \
OPENVSCODE_PORT_VALUE="$openvscode_port" \
OPENVSCODE_EXECUTABLE_VALUE="$openvscode_executable_file" \
ZELLIJ_CONFIG_VALUE="$zellij_config_file" \
ZELLIJ_TOKEN_DB_VALUE="$zellij_token_database_file" \
ZELLIJ_BINARY_VALUE="$managed_zellij_file" \
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
  zellij: {
        webPort: Number(process.env.ZELLIJ_PORT_VALUE),
        managedBinaryFile: process.env.ZELLIJ_BINARY_VALUE,
    configFile: process.env.ZELLIJ_CONFIG_VALUE,
    webTokenDatabaseFile: process.env.ZELLIJ_TOKEN_DB_VALUE,
    webCertificateFile: process.env.CERTIFICATE_FILE_VALUE,
    webPrivateKeyFile: process.env.PRIVATE_KEY_FILE_VALUE,
  },
    openVSCode: {
    executableFile: process.env.OPENVSCODE_EXECUTABLE_VALUE,
    port: Number(process.env.OPENVSCODE_PORT_VALUE),
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
    ['show_startup_tips', 'show_startup_tips false'],
    ['show_release_notes', 'show_release_notes false'],
    ['web_server_ip', 'web_server_ip "127.0.0.1"'],
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
echo "The management service and OpenVSCode Server were not started."
echo "OpenVSCode executable: $openvscode_executable_file"
echo "OpenVSCode localhost upstream port: $openvscode_port"
echo "The self-signed certificate and Zellij token will be created when the service is started separately."
