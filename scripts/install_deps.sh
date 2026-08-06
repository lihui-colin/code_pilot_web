#!/usr/bin/env bash

sourced=false
source_file="${BASH_SOURCE[0]:-}"
if [[ -n "${ZSH_VERSION:-}" ]]; then
    eval 'source_file=${(%):-%x}'
    sourced=true
    elif [[ -n "$source_file" && "$source_file" != "$0" ]]; then
    sourced=true
fi

if [[ "$sourced" == true ]]; then
    script_file="$(cd "$(dirname "$source_file")" && pwd)/$(basename "$source_file")"
    CODEPILOT_ACTIVATE_PARENT=1 bash "$script_file" "$@" || return
    hash -r
    echo "codepilot-server is ready in the current terminal: $(command -v codepilot-server)"
    return
else
    set -euo pipefail
    
    project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    
    die() {
        echo "Error: $*" >&2
        exit 1
    }
    
    for command_name in node npm; do
        command -v "$command_name" >/dev/null 2>&1 \
        || die "required command is not installed: $command_name"
    done
    
    echo "Using current Node.js $(node --version) and npm $(npm --version)..."
    echo "Installing project dependencies..."
    cd "$project_root"
    npm install
    
    chmod +x "$project_root/scripts/codepilot-server"
    echo "Registering codepilot-server command..."
    rm -f "$HOME/.local/bin/codepilot-server"
    mkdir -p "$HOME/.npm-global"
    npm_config_prefix="$HOME/.npm-global" npm link
    hash -r
    codepilot_server_command="$HOME/.npm-global/bin/codepilot-server"
    [[ -x "$codepilot_server_command" ]] \
    || die "codepilot-server was not registered at $codepilot_server_command"
    
    echo
    echo "Dependency installation complete."
    echo "Node.js: $(node --version)"
    echo "npm: $(npm --version)"
    echo "Command: $codepilot_server_command"
    if [[ "${CODEPILOT_ACTIVATE_PARENT:-0}" != "1" ]]; then
        echo "To activate the current terminal, run: source ./scripts/install_deps.sh"
    fi
    echo "Next: codepilot-server init"
    echo "Then: npm run build"
fi
