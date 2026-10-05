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
# LLM_TESTS_FORGE_LIBRARY_DIRECTORY replaces /lib, where musl's loader is
# looked for; tests point it at a temporary directory.
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

# The names are the npm ones (darwin/linux, x64/arm64, ia32 for every 32-bit
# x86), which are also the asset names.
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
i386 | i486 | i586 | i686 | x86) architecture="ia32" ;;
*) architecture="$machine_name" ;;
esac
case "$operating_system-$architecture" in
darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
*) fail "$BINARY_NAME has no binary for $kernel_name $machine_name (uname -s, uname -m): the release has no asset $BINARY_NAME-$operating_system-$architecture; see $REPOSITORY_URL" ;;
esac

# musl Linux (Alpine) cannot load the Linux binaries, which are built against
# glibc. ldd --version decides, as in rustup-init.sh: musl's names musl (on
# stderr), glibc's names GLIBC or GNU libc, and that is decisive even beside
# a musl loader (Debian with the musl package installs /lib/ld-musl-*). Only
# when ldd names neither does musl's dynamic loader count.
is_musl() {
	ldd_version="$(ldd --version 2>&1 || true)"
	case "$ldd_version" in
	*musl*) return 0 ;;
	*GLIBC* | *"GNU libc"* | *"GNU C Library"*) return 1 ;;
	esac
	for loader in "${LLM_TESTS_FORGE_LIBRARY_DIRECTORY:-/lib}"/ld-musl-*; do
		if [ -e "$loader" ]; then
			return 0
		fi
	done
	return 1
}
if [ "$operating_system" = linux ] && is_musl; then
	fail "$BINARY_NAME has no binary for musl/Alpine yet ($operating_system-$architecture-musl): the $operating_system-$architecture binary needs glibc; see $REPOSITORY_URL"
fi
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
temporary_path=""
cleanup() {
	rm -rf "$work_directory"
	if [ -n "$temporary_path" ]; then rm -f "$temporary_path"; fi
}
# A trap on INT or TERM alone would run and then let the script carry on, so
# each one exits (128 plus the signal), and the EXIT trap cleans up after it.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Downloading %s/%s\n' "$base_url" "$asset_name"
download "$base_url/$asset_name" "$work_directory/$asset_name" ||
	fail "cannot download $base_url/$asset_name"
download "$base_url/SHA256SUMS" "$work_directory/SHA256SUMS" ||
	fail "cannot download $base_url/SHA256SUMS"

# The line for this asset, by its exact name (or `*name`, the binary-mode form
# sha256sum -b writes): an empty match is an error, never a pass.
expected_hash="$(awk -v name="$asset_name" '$2 == name || $2 == "*" name { print $1 }' "$work_directory/SHA256SUMS")"
[ -n "$expected_hash" ] || fail "SHA256SUMS does not list $asset_name"
actual_hash="$(sha256_of "$work_directory/$asset_name")"
if [ "$actual_hash" != "$expected_hash" ]; then
	fail "checksum mismatch for $asset_name: expected $expected_hash, got $actual_hash; nothing was installed"
fi

mkdir -p "$install_directory"
target_path="$install_directory/$BINARY_NAME"
# mv onto a directory would move the binary inside it and report success.
if [ -d "$target_path" ]; then
	fail "$target_path is a directory; remove it or choose another --dir; nothing was installed"
fi
# Copy beside the target and rename over it, so a failed copy never leaves a half-written binary there.
temporary_path="$target_path.tmp.$$"
cp "$work_directory/$asset_name" "$temporary_path"
chmod 755 "$temporary_path"
mv -f "$temporary_path" "$target_path"
temporary_path=""

printf 'Installed %s\n' "$target_path"
case ":${PATH:-}:" in
*":$install_directory:"*) printf '%s is on your PATH.\n' "$install_directory" ;;
*) printf '%s is not on your PATH; add it, for example: export PATH="%s:%s"\n' "$install_directory" "$install_directory" "\$PATH" ;;
esac
