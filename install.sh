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
#
# SHA256SUMS proves the download is intact (integrity), not who built it: it
# comes from the same release as the binary. Provenance comes from the GitHub
# artifact attestation the release workflow signs. When gh (the GitHub CLI) is
# on the PATH, `gh attestation verify` checks it, and:
#   - verified: one line says so, and the binary is installed;
#   - gh is not logged in (gh's exit status 4, "requires authentication"):
#     installed on the checksum, with a note on stderr and the command to
#     check it later; refusing would fail every user whose gh is not logged in;
#   - any other failure (no attestation, a mismatch, a network error, a bad
#     token: gh exits 1 for all of them) or no answer within
#     LLM_TESTS_FORGE_GH_TIMEOUT seconds (default 60): nothing is installed.
#     Telling a network error from a refusal would mean reading gh's English
#     error text, and a rewording would silently turn a refusal into a pass.
# Without gh, the binary is installed on the checksum, with the same note.
set -eu

REPOSITORY="albertosca/llm-tests-forge"
REPOSITORY_URL="https://github.com/$REPOSITORY"
SIGNER_WORKFLOW="$REPOSITORY/.github/workflows/release.yml"
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

gh_timeout="${LLM_TESTS_FORGE_GH_TIMEOUT-60}"
case "$gh_timeout" in
'' | *[!0-9]* | 0*)
	printf '%s\n' "LLM_TESTS_FORGE_GH_TIMEOUT must be a whole number of seconds above 0, not '$gh_timeout'" >&2
	exit 2
	;;
esac

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
gh_process=""
watchdog_process=""
cleanup() {
	# A gh still running when the script stops (an INT or TERM while it
	# verifies) runs in the background, where INT is ignored: stop it here.
	if [ -n "$gh_process" ]; then kill "$gh_process" 2>/dev/null || true; fi
	if [ -n "$watchdog_process" ]; then kill "$watchdog_process" 2>/dev/null || true; fi
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

target_path="$install_directory/$BINARY_NAME"
verify_command="gh attestation verify \"$target_path\" --repo $REPOSITORY --signer-workflow $SIGNER_WORKFLOW"
provenance_note=""
if command -v gh >/dev/null 2>&1; then
	gh_output="$work_directory/gh-output"
	gh_timed_out="$work_directory/gh-timed-out"
	# GH_HOST pins github.com over a GH_HOST the user set for another host;
	# GH_PROMPT_DISABLED keeps gh from ever waiting on a prompt.
	GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
		gh attestation verify "$work_directory/$asset_name" --repo "$REPOSITORY" --signer-workflow "$SIGNER_WORKFLOW" \
		>"$gh_output" 2>&1 </dev/null &
	gh_process=$!
	# A watchdog, as POSIX sh has no timeout: it stops gh after $gh_timeout
	# seconds, and leaves a mark so the refusal can say gh did not answer.
	(
		trap - EXIT INT TERM
		remaining="$gh_timeout"
		while [ "$remaining" -gt 0 ]; do
			sleep 1
			kill -0 "$gh_process" 2>/dev/null || exit 0
			remaining=$((remaining - 1))
		done
		: >"$gh_timed_out"
		kill "$gh_process" 2>/dev/null
	) >/dev/null 2>&1 &
	watchdog_process=$!
	gh_status=0
	# dash reports a job killed by a signal ("Terminated") on wait's stderr.
	wait "$gh_process" 2>/dev/null || gh_status=$?
	kill "$watchdog_process" 2>/dev/null || true
	wait "$watchdog_process" 2>/dev/null || true
	# Both are gone: cleanup must not signal a pid the system may reuse.
	gh_process=""
	watchdog_process=""
	if [ -e "$gh_timed_out" ]; then
		fail "provenance check failed for $asset_name: gh attestation verify did not answer within $gh_timeout seconds (can this machine reach api.github.com?); nothing was installed"
	fi
	case "$gh_status" in
	0) printf 'Provenance verified: %s was built by %s\n' "$asset_name" "$SIGNER_WORKFLOW" ;;
	4) provenance_note="provenance not checked: gh is not logged in (gh auth login), so it cannot fetch the attestation; the binary matched SHA256SUMS. To check it: $verify_command" ;;
	*)
		printf '%s\n' "provenance check failed for $asset_name: gh attestation verify exited $gh_status, so nothing proves it was built by $SIGNER_WORKFLOW; nothing was installed. gh said:" >&2
		cat "$gh_output" >&2
		exit 1
		;;
	esac
else
	provenance_note="provenance not checked: gh (the GitHub CLI, https://cli.github.com) is not installed; the binary matched SHA256SUMS. To check it: $verify_command"
fi

mkdir -p "$install_directory"
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
if [ -n "$provenance_note" ]; then
	printf '%s\n' "$provenance_note" >&2
fi
