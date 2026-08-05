#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openvscode_version="1.109.5"
download_directory="$project_root/data/openvscode"
current_link="$download_directory/current"

die() {
    echo "Error: $*" >&2
    exit 1
}

for command_name in curl tar uname mktemp sed sha256sum; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is not installed: $command_name"
done

[[ "$(uname -s)" == "Linux" ]] || die "OpenVSCode Server $openvscode_version is only available for Linux"

case "$(uname -m)" in
    x86_64|amd64)
        architecture="x64"
        expected_sha256="b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363"
    ;;
    arm64|aarch64)
        architecture="arm64"
        expected_sha256="36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc"
    ;;
    armv7l|armv7*)
        architecture="armhf"
        expected_sha256="f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb"
    ;;
    *) die "OpenVSCode Server $openvscode_version is not available for this CPU architecture" ;;
esac

installation_name="openvscode-server-v${openvscode_version}-linux-${architecture}"
installation_directory="$download_directory/$installation_name"
executable="$installation_directory/bin/openvscode-server"

[[ ! -e "$current_link" || -L "$current_link" ]] \
|| die "$current_link exists and is not a symbolic link"

read_version() {
    "$1" --version 2>/dev/null | sed -n '1p'
}

if [[ -x "$executable" ]]; then
    installed_version="$(read_version "$executable" || true)"
    [[ "$installed_version" == "$openvscode_version" ]] \
    || die "$installation_directory exists but reports '${installed_version:-no version}'"
    ln -sfn "$installation_name" "$current_link"
    echo "OpenVSCode Server $openvscode_version is already installed at $installation_directory"
    exit 0
fi

[[ ! -e "$installation_directory" ]] \
|| die "$installation_directory already exists but is not a valid OpenVSCode Server $openvscode_version installation"

archive_name="${installation_name}.tar.gz"
download_url="https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${openvscode_version}/${archive_name}"
mkdir -p -m 700 "$download_directory"
temporary_directory="$(mktemp -d "$download_directory/.openvscode-download.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT

echo "Downloading OpenVSCode Server $openvscode_version..."
curl --fail --show-error --location --progress-bar \
--connect-timeout 30 --max-time 3600 --max-filesize 536870912 \
--output "$temporary_directory/$archive_name" \
"$download_url"

checksum_output="$(sha256sum "$temporary_directory/$archive_name")"
actual_sha256="${checksum_output%% *}"
[[ "$actual_sha256" == "$expected_sha256" ]] open\
|| die "downloaded archive checksum did not match the official release digest"

tar -xzf "$temporary_directory/$archive_name" \
-C "$temporary_directory" \
--no-same-owner \
--no-same-permissions

extracted_directory="$temporary_directory/$installation_name"
extracted_executable="$extracted_directory/bin/openvscode-server"
[[ -x "$extracted_executable" ]] || die "downloaded archive does not contain $installation_name/bin/openvscode-server"

installed_version="$(read_version "$extracted_executable" || true)"
[[ "$installed_version" == "$openvscode_version" ]] \
|| die "downloaded executable reported '${installed_version:-no version}'"

mv "$extracted_directory" "$installation_directory"
ln -sfn "$installation_name" "$current_link"
echo "Installed OpenVSCode Server $openvscode_version at $installation_directory"
