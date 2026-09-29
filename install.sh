#!/bin/sh
# Installs the llm-tests-forge binary of a GitHub Release, after checking it
# against the release's SHA256SUMS.
#
#   curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh
#   sh install.sh [--version vX.Y.Z] [--dir <bin-directory>]
#
# The directory defaults to ~/.local/bin and the release to the latest one.
# LLM_TESTS_FORGE_BASE_URL replaces the download location (the directory that
# holds the assets and SHA256SUMS); tests point it at a local server.
set -eu

REPOSITORY_URL="https://github.com/albertosca/llm-tests-forge"
BINARY_NAME="llm-tests-forge"

fail() {
	printf '%s\n' "$*" >&2
	exit 1
}

usage() {
	printf '%s\n' "usage: install.sh [--version vX.Y.Z] [--dir <bin-directory>]" >&2
	exit 2
}

version=""
install_directory=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	--version)
		[ "$#" -ge 2 ] || usage
		version="$2"
		shift 2
		;;
	--dir)
		[ "$#" -ge 2 ] || usage
		install_directory="$2"
		shift 2
		;;
	*) usage ;;
	esac
done

if [ -z "$install_directory" ]; then
	install_directory="${HOME:?HOME is not set; pass --dir}/.local/bin"
fi

# The names are the npm ones (darwin/linux, x64/arm64), which are also the asset names.
kernel_name="$(uname -s)"
machine_name="$(uname -m)"
case "$kernel_name" in
Darwin) operating_system="darwin" ;;
Linux) operating_system="linux" ;;
*) operating_system="$(printf '%s' "$kernel_name" | tr '[:upper:]' '[:lower:]')" ;;
esac
case "$machine_name" in
arm64 | aarch64) architecture="arm64" ;;
x86_64 | amd64) architecture="x64" ;;
*) architecture="$machine_name" ;;
esac
case "$operating_system-$architecture" in
darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
*) fail "$BINARY_NAME has no binary for $operating_system-$architecture; see $REPOSITORY_URL" ;;
esac
asset_name="$BINARY_NAME-$operating_system-$architecture"

if [ -n "${LLM_TESTS_FORGE_BASE_URL:-}" ]; then
	base_url="${LLM_TESTS_FORGE_BASE_URL%/}"
elif [ -n "$version" ]; then
	case "$version" in v*) ;; *) version="v$version" ;; esac
	base_url="$REPOSITORY_URL/releases/download/$version"
else
	base_url="$REPOSITORY_URL/releases/latest/download"
fi

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "neither curl nor wget is installed"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		fail "neither sha256sum nor shasum is installed"
	fi
}

work_directory="$(mktemp -d)"
trap 'rm -rf "$work_directory"' EXIT INT TERM

printf 'Downloading %s/%s\n' "$base_url" "$asset_name"
download "$base_url/$asset_name" "$work_directory/$asset_name" ||
	fail "cannot download $base_url/$asset_name"
download "$base_url/SHA256SUMS" "$work_directory/SHA256SUMS" ||
	fail "cannot download $base_url/SHA256SUMS"

# The line for this asset, by its exact name: an empty match is an error, never a pass.
expected_hash="$(awk -v name="$asset_name" '$2 == name { print $1 }' "$work_directory/SHA256SUMS")"
[ -n "$expected_hash" ] || fail "SHA256SUMS does not list $asset_name"
actual_hash="$(sha256_of "$work_directory/$asset_name")"
if [ "$actual_hash" != "$expected_hash" ]; then
	fail "checksum mismatch for $asset_name: expected $expected_hash, got $actual_hash; nothing was installed"
fi

mkdir -p "$install_directory"
target_path="$install_directory/$BINARY_NAME"
# Copy beside the target and rename over it, so a failed copy never leaves a half-written binary there.
cp "$work_directory/$asset_name" "$target_path.tmp.$$"
chmod 755 "$target_path.tmp.$$"
mv -f "$target_path.tmp.$$" "$target_path"

printf 'Installed %s\n' "$target_path"
case ":${PATH:-}:" in
*":$install_directory:"*) printf '%s is on your PATH.\n' "$install_directory" ;;
*) printf '%s is not on your PATH; add it, for example: export PATH="%s:%s"\n' "$install_directory" "$install_directory" "\$PATH" ;;
esac
