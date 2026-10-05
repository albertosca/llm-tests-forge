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
# artifact attestation the release workflow signs. When gh (the GitHub CLI,
# 2.49 or newer) is on the PATH, `gh attestation verify` checks it, with
# GH_HOST=github.com: that makes gh check anonymously when it is not logged in
# (without GH_HOST, a gh that was never logged in exits 4 asking for a login),
# and keeps a GH_HOST the user set for another host out of it. Then:
#   - verified (exit 0): one line says so, and the binary is installed;
#   - any failure (gh exits 1 for no attestation, a mismatch, a network
#     error, a rejected token or a rate limit alike, and 4 if some gh still
#     asks for a login) or no answer within LLM_TESTS_FORGE_GH_TIMEOUT seconds
#     (default 60): nothing is installed. gh's message only picks the hint
#     printed after it, never whether to install: a rewording in a future gh
#     can blur the hint, not turn a refusal into a pass.
# Without gh, or with a gh that has no `attestation` command, the binary is
# installed on the checksum, with a note on stderr and the command to check
# it. LLM_TESTS_FORGE_PROVENANCE=skip installs on the checksum without asking
# gh, and says so with a WARNING; every refusal names it.
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
provenance_mode="${LLM_TESTS_FORGE_PROVENANCE-}"
case "$provenance_mode" in
'' | skip) ;;
*)
	printf '%s\n' "LLM_TESTS_FORGE_PROVENANCE must be unset or skip, not '$provenance_mode'" >&2
	exit 2
	;;
esac
if [ -n "$version" ]; then
	case "$version" in v*) ;; *) version="v$version" ;; esac
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
# Who must have built it: this repository's release workflow (gh 2.101.0
# anchors --signer-workflow at the start of the certificate's workflow path
# and accepts nothing but an @ref after it, measured: neither
# ".../deployment.ym" nor ".../workflows/" matched ".../deployment.yml"),
# on a GitHub-hosted runner, and, when --version names the release, from
# that tag. The arguments live in "$@", which the option loop emptied.
set -- --repo "$REPOSITORY" --signer-workflow "$SIGNER_WORKFLOW" --deny-self-hosted-runners
if [ -n "$version" ]; then
	set -- "$@" --source-ref "refs/tags/$version"
fi
verify_command="gh attestation verify \"$target_path\" $*"
intact_only="the binary matched SHA256SUMS, which proves it arrived intact, not who built it"
skip_hint="To install anyway on the checksum alone, which does not prove who built the binary, run install.sh again with LLM_TESTS_FORGE_PROVENANCE=skip, for example: curl -fsSL $REPOSITORY_URL/releases/latest/download/install.sh | LLM_TESTS_FORGE_PROVENANCE=skip sh"
hosts_hint="Check: gh needs https://api.github.com, https://tuf-repo-cdn.sigstore.dev and https://tuf-repo.github.com; a proxy or firewall may block one."

# What to check after a refusal, from gh's exit status and message ($1, $2).
# It only words the hint: the refusal itself never depends on the message.
refusal_hint() {
	if [ "$1" = 4 ]; then
		printf '%s\n' "Check: this gh asks for a login even for an anonymous check; run gh auth login."
		return
	fi
	case "$2" in
	*"rate limit"*) printf '%s\n' "Check: GitHub's rate limit for anonymous API requests (60 an hour per address) was reached; wait for it to reset, or log gh in (gh auth login) for a higher limit." ;;
	*"HTTP 401"* | *"Bad credentials"*) printf '%s\n' "Check: GitHub rejected gh's token (revoked, expired, or a GitHub Enterprise token in GH_TOKEN or GITHUB_TOKEN); run gh auth status and gh auth login, or unset GH_TOKEN and GITHUB_TOKEN to check anonymously." ;;
	*"no attestations found"* | *"HTTP 404"*) printf '%s\n' "Check: the release may predate attestations, or the binary may not come from $REPOSITORY; try a newer release (--version), and see $REPOSITORY_URL/attestations." ;;
	*"verifying with issuer"* | *"expected Source"* | *"SAN"* | *"self-hosted"*) printf '%s\n' "Check: an attestation exists, but not from $REPOSITORY's release workflow for this release; do not run this binary, and report it at $REPOSITORY_URL/issues." ;;
	*"Sigstore verifier"* | *"dial tcp"* | *"no such host"* | *"connection refused"* | *"i/o timeout"* | *"TLS"* | *"proxyconnect"* | *"deadline exceeded"*) printf '%s\n' "$hosts_hint" ;;
	*) printf '%s\n' "Check: what gh said above." ;;
	esac
}

provenance_note=""
if [ "$provenance_mode" = skip ]; then
	provenance_note="WARNING: provenance NOT checked (LLM_TESTS_FORGE_PROVENANCE=skip): $intact_only. To check it: $verify_command"
elif ! command -v gh >/dev/null 2>&1; then
	provenance_note="provenance not checked: gh (the GitHub CLI, https://cli.github.com) is not installed; $intact_only. To check it with gh 2.49 or newer: $verify_command"
elif ! GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 gh attestation verify --help >/dev/null 2>&1 </dev/null; then
	# gh before 2.49 has no attestation command: as good as no gh.
	provenance_note="provenance not checked: this gh has no attestation command (gh 2.49 or newer has it); $intact_only. To check it after upgrading gh: $verify_command"
else
	gh_output="$work_directory/gh-output"
	gh_timed_out="$work_directory/gh-timed-out"
	# GH_HOST=github.com makes a gh that is not logged in check anonymously
	# (without it, gh exits 4 asking for a login) and overrides a GH_HOST the
	# user set for another host; GH_PROMPT_DISABLED keeps gh from waiting on a
	# prompt.
	GH_HOST=github.com GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 \
		gh attestation verify "$work_directory/$asset_name" "$@" \
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
		printf '%s\n' "provenance check failed for $asset_name: gh attestation verify did not answer within $gh_timeout seconds; nothing was installed." "$hosts_hint" "$skip_hint" >&2
		exit 1
	fi
	if [ "$gh_status" -ne 0 ]; then
		# gh puts an empty line before its "Error:" line; the refusal drops it.
		gh_said="$(sed '/^[[:space:]]*$/d' "$gh_output")"
		printf '%s\n' "provenance check failed for $asset_name: gh attestation verify exited $gh_status, so nothing proves it was built by $SIGNER_WORKFLOW; nothing was installed. gh said:" "$gh_said" >&2
		refusal_hint "$gh_status" "$gh_said" >&2
		printf '%s\n' "$skip_hint" >&2
		exit 1
	fi
	printf 'Provenance verified: %s was built by %s\n' "$asset_name" "$SIGNER_WORKFLOW"
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
