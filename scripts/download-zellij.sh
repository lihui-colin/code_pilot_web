#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zellij_version="0.44.3"
download_directory="$project_root/data/zellij"
downloaded_binary="$download_directory/zellij"
destination="$HOME/.local/bin/zellij"

die() {
    echo "Error: $*" >&2
    exit 1
}

for command_name in cp curl tar uname mktemp; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is not installed: $command_name"
done

case "$(uname -s)" in
    Linux) platform="unknown-linux-musl" ;;
    Darwin) platform="apple-darwin" ;;
    *) die "Zellij $zellij_version is not available for this operating system" ;;
esac

case "$(uname -m)" in
    x86_64|amd64) architecture="x86_64" ;;
    arm64|aarch64) architecture="aarch64" ;;
    *) die "Zellij $zellij_version is not available for this CPU architecture" ;;
esac

if [[ -e "$destination" ]]; then
    existing_version="$($destination --version 2>/dev/null || true)"
    if [[ "$existing_version" == "zellij $zellij_version" ]]; then
        echo "Zellij $zellij_version is already installed at $destination"
        exit 0
    fi
    die "$destination already exists and is not Zellij $zellij_version; remove it explicitly before downloading"
fi

archive_name="zellij-${architecture}-${platform}.tar.gz"
download_url="https://github.com/zellij-org/zellij/releases/download/v${zellij_version}/${archive_name}"
destination_directory="$(dirname "$destination")"
mkdir -p -m 700 "$download_directory" "$destination_directory"
temporary_directory="$(mktemp -d "$download_directory/.zellij-download.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT

echo "Downloading Zellij $zellij_version..."
curl --fail --show-error --location --progress-bar \
--connect-timeout 30 --max-time 1800 --max-filesize 134217728 \
--output "$temporary_directory/zellij.tar.gz" \
"$download_url"

tar -xzf "$temporary_directory/zellij.tar.gz" \
-C "$temporary_directory" \
--no-same-owner \
--no-same-permissions \
zellij
chmod 755 "$temporary_directory/zellij"

installed_version="$($temporary_directory/zellij --version 2>/dev/null || true)"
[[ "$installed_version" == "zellij $zellij_version" ]] \
|| die "downloaded executable reported '${installed_version:-no version}'"

mv -f "$temporary_directory/zellij" "$downloaded_binary"
cp "$downloaded_binary" "$destination"
echo "Installed Zellij $zellij_version at $destination"
