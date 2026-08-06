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
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use 26
    hash -r
    echo "codepilot-server is ready in the current terminal: $(command -v codepilot-server)"
    return
else
    set -euo pipefail
    
    project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    nvm_version="v0.40.3"
    node_version="26"
    
    die() {
        echo "Error: $*" >&2
        exit 1
    }
    
    command -v curl >/dev/null 2>&1 || die "required command is not installed: curl"
    
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
    nvm alias default "$node_version"
    
    echo "Installing project dependencies..."
    cd "$project_root"
    npm install
    
    chmod +x "$project_root/scripts/codepilot-server"
    echo "Registering codepilot-server command..."
    npm link
    codepilot_server_command="$(command -v codepilot-server || true)"
    [[ -n "$codepilot_server_command" ]] \
    || die "codepilot-server was registered but is not available in PATH"
    
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
