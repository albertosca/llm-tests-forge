/**
 * install.sh, end to end: the host binary compiled and checksummed, served by
 * a local server, and the script run into a temporary directory; a corrupted
 * download must be refused with the asset named and nothing installed, and an
 * unsupported platform (a fake `uname` first on the PATH) must exit 1 naming
 * it. The provenance check runs against a fake `gh` first on the PATH (never
 * the real one, which would ask GitHub about a binary built here): verified,
 * refused, not logged in, unreachable, hung, and absent. Off by default; run
 * with `bun run test:packages` (sets FORGE_PACKAGES=1). It needs `sh` and
 * `curl` on the PATH; FORGE_INSTALL_SHELL runs the script under another shell
 * (dash, for one).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { writeChecksums } from "../../scripts/release/checksums";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";
import { muslMessage } from "../helpers/platform-messages";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const INSTALL_SCRIPT = join(REPOSITORY, "install.sh");
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform &&
		target.npmCpu === process.arch &&
		target.homebrew !== null,
);

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const INSTALL_SHELL = process.env.FORGE_INSTALL_SHELL ?? "sh";
const SIGNER_WORKFLOW =
	"albertosca/llm-tests-forge/.github/workflows/release.yml";

/**
 * What a fake `gh attestation verify` answers with GH_HOST=github.com set,
 * as the real gh answers (measured with gh 2.101.0 and 2.102.0, except
 * where marked): verified (exit 0, silent), a refusal or a network error
 * (exit 1, one line), or no answer at all.
 */
const FAKE_GH_ANSWERS = {
	verified: { exitCode: 0, said: "" },
	"no-attestation": { exitCode: 1, said: "Error: no attestations found" },
	"not-found": {
		exitCode: 1,
		said: "Error: HTTP 404: Not Found (https://api.github.com/repos/albertosca/llm-tests-forge/attestations/sha256:0000?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)",
	},
	// Not measured: the unauthenticated quota on this machine could not be reached
	// without a token (gh reads the keychain's for GH_HOST). gh formats every API
	// error as "HTTP <status>: <GitHub's message> (<url>)", and this is GitHub's message.
	"rate-limited": {
		exitCode: 1,
		said: "Error: HTTP 403: API rate limit exceeded for 203.0.113.7. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.) (https://api.github.com/repos/albertosca/llm-tests-forge/attestations/sha256:0000?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)",
	},
	"bad-token": {
		exitCode: 1,
		said: "Error: HTTP 401: Bad credentials (https://api.github.com/repos/albertosca/llm-tests-forge/attestations/sha256:0000?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1)",
	},
	unreachable: {
		exitCode: 1,
		said: "error creating Sigstore verifier: no valid Sigstore verifiers could be initialized",
	},
	"wrong-signer": {
		exitCode: 1,
		said: 'Error: verifying with issuer "sigstore.dev"',
	},
	"wrong-ref": {
		exitCode: 1,
		said: "Error: expected SourceRepositoryRef to be refs/tags/v1.2.3, got refs/tags/v1.2.2",
	},
	// A gh that asked for a login even with GH_HOST set (none measured does): exit 4.
	"login-required": {
		exitCode: 4,
		said: "To get started with GitHub CLI, please run:  gh auth login",
	},
	// gh prints nothing and exits 1 (none measured does; the hint must say so).
	silent: { exitCode: 1, said: "" },
	// An answer no hint pattern is for, with words that a loose pattern
	// (*SAN*, *TLS*) would have taken for a signer or a network error.
	unrelated: {
		exitCode: 1,
		said: "Error: HTTP 502: Bad Gateway, SANDBOX upstream (TLSv1.3 fine) (https://api.github.com/repos/albertosca/llm-tests-forge/attestations/sha256:0000)",
	},
	hangs: { exitCode: 0, said: "" },
} as const;

/** What gh 2.45.0 prints for `gh attestation verify --help` (measured; its command list cut short). */
const GH_245_UNKNOWN_COMMAND =
	'unknown command "attestation" for "gh"\n\nUsage:  gh <command> <subcommand> [flags]\n\nAvailable commands:\n  alias\n  api\n  auth';

/**
 * How the probe (`gh attestation verify --help`) fails, exit 1: gh 2.45.0's
 * unknown command (measured on stderr; also tried on stdout), and gh
 * 2.102.0 failing to read its configuration (measured: invalid YAML, an
 * unreadable config.yml, GH_CONFIG_DIR naming a file).
 */
const FAKE_PROBE_ANSWERS = {
	"too-old": { onStdout: false, said: GH_245_UNKNOWN_COMMAND },
	"too-old-on-stdout": { onStdout: true, said: GH_245_UNKNOWN_COMMAND },
	"probe-invalid-config": {
		onStdout: false,
		said: "warning: failed to load config: invalid config file /home/someone/.config/gh/config.yml: invalid yaml\nfailed to create root command: failed to read configuration: invalid config file /home/someone/.config/gh/config.yml: invalid yaml",
	},
	"probe-unreadable-config": {
		onStdout: false,
		said: "warning: failed to load config: open /home/someone/.config/gh/config.yml: permission denied\nfailed to create root command: failed to read configuration: open /home/someone/.config/gh/config.yml: permission denied",
	},
	"probe-config-not-a-directory": {
		onStdout: false,
		said: "warning: failed to load config: open /home/someone/gh-config/config.yml: not a directory\nfailed to create root command: failed to read configuration: open /home/someone/gh-config/config.yml: not a directory",
	},
	"probe-silent": { onStdout: false, said: "" },
} as const;
type ProbeAnswer = keyof typeof FAKE_PROBE_ANSWERS;
type FakeGh = keyof typeof FAKE_GH_ANSWERS | ProbeAnswer | "probe-hangs";

function isProbeAnswer(behavior: FakeGh): behavior is ProbeAnswer {
	return behavior in FAKE_PROBE_ANSWERS;
}

/** Shell lines printing `said`, one printf per line, on stderr or stdout. */
function printLines(said: string, onStdout: boolean): string[] {
	if (said === "") return [];
	return said
		.split("\n")
		.map(
			(line) =>
				`printf '%s\\n' '${line.replaceAll("'", "'\\''")}'${onStdout ? "" : " >&2"}`,
		);
}

/**
 * A directory holding a `gh`, to put first on the PATH. Like a real gh that
 * was never logged in, it exits 4 asking for a login unless GH_HOST is set
 * (with GH_HOST, gh verifies anonymously). A probe answer makes
 * `gh attestation verify --help` fail as given, or hang (`probe-hangs`);
 * otherwise the probe exits 0 and the verify call answers as `behavior`
 * says. Every call is appended to `calls`; the verify call also records
 * its arguments, the environment install.sh gives it, its own pid, and a
 * copy of the file it was asked to verify.
 */
async function fakeGh(behavior: FakeGh): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-fake-gh-"));
	workDirectories.push(directory);
	const probeLines = isProbeAnswer(behavior)
		? [
				...printLines(
					FAKE_PROBE_ANSWERS[behavior].said,
					FAKE_PROBE_ANSWERS[behavior].onStdout,
				),
				"exit 1",
			]
		: behavior === "probe-hangs"
			? [`echo "$$" > "${directory}/pid"`, "exec sleep 60"]
			: ["exit 0"];
	const answer =
		isProbeAnswer(behavior) || behavior === "probe-hangs"
			? FAKE_GH_ANSWERS.verified
			: FAKE_GH_ANSWERS[behavior];
	const lines = [
		`echo "$*" >> "${directory}/calls"`,
		'for argument; do last="$argument"; done',
		'if [ "$last" = "--help" ]; then',
		...probeLines,
		"fi",
		`printf '%s\\n' "$@" > "${directory}/arguments"`,
		`printf '%s\\n' "GH_PROMPT_DISABLED=\${GH_PROMPT_DISABLED:-unset}" "GH_HOST=\${GH_HOST:-unset}" > "${directory}/environment"`,
		`echo "$$" > "${directory}/pid"`,
		`cp "$3" "${directory}/subject" 2>/dev/null || true`,
		`if [ -z "\${GH_HOST:-}" ]; then`,
		'  echo "To get started with GitHub CLI, please run:  gh auth login" >&2',
		'  echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2',
		"  exit 4",
		"fi",
		...(behavior === "hangs"
			? ["exec sleep 60"]
			: [
					// gh 2.101.0 prints an empty line before an "Error:" line.
					...(answer.said.startsWith("Error:") ? ["echo >&2"] : []),
					...printLines(answer.said, false),
					`exit ${answer.exitCode}`,
				]),
	];
	await writeFile(
		join(directory, "gh"),
		["#!/bin/sh", ...lines, ""].join("\n"),
	);
	await chmod(join(directory, "gh"), 0o755);
	return directory;
}

let defaultGhDirectory: Promise<string> | undefined;

/**
 * Runs install.sh with a fake `gh` first on the PATH: `ghDirectory` when
 * given, otherwise one that verifies, so no test reaches the real gh.
 */
async function runScript(
	argumentsList: string[],
	extraEnvironment: Record<string, string>,
	ghDirectory?: string,
): Promise<Finished> {
	defaultGhDirectory ??= fakeGh("verified");
	const ghCommandDirectory = ghDirectory ?? (await defaultGhDirectory);
	const path = extraEnvironment.PATH ?? process.env.PATH ?? "";
	const child = Bun.spawn([INSTALL_SHELL, INSTALL_SCRIPT, ...argumentsList], {
		cwd: REPOSITORY,
		env: {
			...process.env,
			...extraEnvironment,
			PATH: `${ghCommandDirectory}:${path}`,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

const workDirectories: string[] = [];
const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(async () => {
	for (const server of servers) await server.stop(true);
	for (const directory of workDirectories)
		await rm(directory, { recursive: true, force: true });
});

/** Serves the files of `directory` by name; `corrupt` flips the first byte of the binary it serves (never SHA256SUMS). */
function serve(directory: string, corrupt: boolean): string {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			const file = Bun.file(join(directory, name));
			if (name === "" || name.includes("/") || !(await file.exists()))
				return new Response("not found", { status: 404 });
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (corrupt && name !== "SHA256SUMS" && bytes.length > 0)
				bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			return new Response(bytes);
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

interface Built {
	work: string;
	intactUrl: string;
	corruptedUrl: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host binary and SHA256SUMS, built once; two servers, one intact and one corrupting. */
function built(): Promise<Built> {
	builtOnce ??= (async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-install-e2e-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await buildBinaries(binaries, HOST.bunTarget);
		await writeChecksums(binaries);
		return {
			work,
			intactUrl: serve(binaries, false),
			corruptedUrl: serve(binaries, true),
		};
	})();
	return builtOnce;
}

/** A directory holding a `uname` that answers `-s` and `-m` with the given values, to put first on the PATH. */
async function fakeUname(
	work: string,
	kernelName: string,
	machineName: string,
): Promise<string> {
	const directory = await mkdtemp(join(work, "fake-uname-"));
	const path = join(directory, "uname");
	await writeFile(
		path,
		`#!/bin/sh\ncase "$1" in\n-s) echo "${kernelName}" ;;\n-m) echo "${machineName}" ;;\n*) echo "${kernelName}" ;;\nesac\n`,
	);
	await chmod(path, 0o755);
	return directory;
}

type FakeLibc = "musl" | "glibc" | "debian-glibc" | "missing";

/**
 * A directory holding an `ldd` that answers `--version` the way musl's does
 * (on stderr, exit 1), the way glibc's does (on stdout; Debian's names it
 * GLIBC), or not at all (as a shell reports a missing command), to put first
 * on the PATH.
 */
async function fakeLdd(work: string, libc: FakeLibc): Promise<string> {
	const directory = await mkdtemp(join(work, "fake-ldd-"));
	const path = join(directory, "ldd");
	const answers: Record<FakeLibc, string> = {
		musl: 'echo "musl libc (x86_64)" >&2\necho "Version 1.2.5" >&2\nexit 1',
		glibc: 'echo "ldd (GNU libc) 2.39"\nexit 0',
		"debian-glibc": 'echo "ldd (Debian GLIBC 2.36-9+deb12u4) 2.36"\nexit 0',
		missing: 'echo "ldd: not found" >&2\nexit 127',
	};
	await writeFile(path, `#!/bin/sh\n${answers[libc]}\n`);
	await chmod(path, 0o755);
	return directory;
}

/**
 * A directory linking every command install.sh runs, and no `gh`: a PATH
 * made of it alone is a machine without the GitHub CLI, even on a runner
 * whose /usr/bin holds gh beside curl.
 */
async function toolsWithoutGh(work: string): Promise<string> {
	const directory = await mkdtemp(join(work, "tools-without-gh-"));
	for (const tool of [
		"sh",
		"dash",
		"uname",
		"tr",
		"ldd",
		"curl",
		"wget",
		"sha256sum",
		"shasum",
		"perl",
		"awk",
		"cut",
		"cat",
		"mktemp",
		"rm",
		"mkdir",
		"cp",
		"chmod",
		"mv",
		"sleep",
	]) {
		const found = Bun.which(tool);
		if (found !== null) await symlink(found, join(directory, tool));
	}
	return directory;
}

/** The command install.sh prints for checking an installed binary by hand. */
function verifyCommand(installedPath: string): string {
	return `gh attestation verify "${installedPath}" --repo albertosca/llm-tests-forge --signer-workflow ${SIGNER_WORKFLOW} --deny-self-hosted-runners`;
}

const SKIP_HINT =
	"To install anyway on the checksum alone, which does not prove who built the binary, run install.sh again with LLM_TESTS_FORGE_PROVENANCE=skip, for example: curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | LLM_TESTS_FORGE_PROVENANCE=skip sh";
/** The skip escape after `--version v1.2.3`: that release's install.sh, pinned to that release. */
const PINNED_SKIP_HINT =
	"To install anyway on the checksum alone, which does not prove who built the binary, run install.sh again with LLM_TESTS_FORGE_PROVENANCE=skip, for example: curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/download/v1.2.3/install.sh | LLM_TESTS_FORGE_PROVENANCE=skip sh -s -- --version v1.2.3";
const HOSTS_HINT =
	"Check: gh needs https://api.github.com, https://tuf-repo-cdn.sigstore.dev and https://tuf-repo.github.com; a proxy or firewall may block one.";
const BROKEN_GH_HINT =
	"Check: gh fails before it runs any command, often over its own configuration (GH_CONFIG_DIR, or ~/.config/gh/config.yml); fix what gh said, then run install.sh again.";

/** What install.sh says to check, for each way gh refuses. */
const REFUSAL_HINTS: Record<
	Exclude<FakeGh, "verified" | "hangs" | ProbeAnswer | "probe-hangs">,
	string
> = {
	silent:
		"Check: gh gave no reason; GH_DEBUG=api in its environment shows what it did.",
	unrelated: "Check: what gh said above.",
	"no-attestation":
		"Check: the release may predate attestations, or the binary may not come from albertosca/llm-tests-forge; try a newer release (--version), and see https://github.com/albertosca/llm-tests-forge/attestations.",
	"not-found":
		"Check: the release may predate attestations, or the binary may not come from albertosca/llm-tests-forge; try a newer release (--version), and see https://github.com/albertosca/llm-tests-forge/attestations.",
	"rate-limited":
		"Check: GitHub's rate limit for anonymous API requests (60 an hour per address) was reached; wait for it to reset, or log gh in (gh auth login) for a higher limit.",
	"bad-token":
		"Check: GitHub rejected gh's token (revoked, expired, or a GitHub Enterprise token in GH_TOKEN or GITHUB_TOKEN); run gh auth status and gh auth login, or unset GH_TOKEN and GITHUB_TOKEN to check anonymously.",
	unreachable: HOSTS_HINT,
	"wrong-signer":
		"Check: an attestation exists, but not from albertosca/llm-tests-forge's release workflow for this release; do not run this binary, and report it at https://github.com/albertosca/llm-tests-forge/issues.",
	"wrong-ref":
		"Check: an attestation exists, but not from albertosca/llm-tests-forge's release workflow for this release; do not run this binary, and report it at https://github.com/albertosca/llm-tests-forge/issues.",
	"login-required":
		"Check: this gh asks for a login even for an anonymous check; run gh auth login.",
};

describe.skipIf(!packages || HOST === undefined)(
	"install.sh's provenance check",
	() => {
		test("with gh on the PATH, never logged in, the downloaded bytes are verified anonymously against the release workflow of albertosca/llm-tests-forge on github.com, without prompting, and one line says so", async () => {
			const { work, intactUrl } = await built();
			if (HOST === undefined) throw new Error("this machine is not a target");
			const fakeGhDirectory = await fakeGh("verified");
			const installDirectory = join(
				await mkdtemp(join(work, "target-")),
				"bin",
			);
			const finished = await runScript(
				["--dir", installDirectory],
				{
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					// A user's own settings, which install.sh must override.
					GH_HOST: "github.example.com",
					GH_PROMPT_DISABLED: "",
				},
				fakeGhDirectory,
			);
			expect(finished.stderr).toBe("");
			expect(finished.exitCode).toBe(0);
			const argumentsList = (
				await readFile(join(fakeGhDirectory, "arguments"), "utf8")
			)
				.trimEnd()
				.split("\n");
			expect(argumentsList[2]?.endsWith(`/${HOST.assetName}`)).toBe(true);
			expect([...argumentsList.slice(0, 2), ...argumentsList.slice(3)]).toEqual(
				[
					"attestation",
					"verify",
					"--repo",
					"albertosca/llm-tests-forge",
					"--signer-workflow",
					SIGNER_WORKFLOW,
					"--deny-self-hosted-runners",
				],
			);
			expect(await readFile(join(fakeGhDirectory, "environment"), "utf8")).toBe(
				"GH_PROMPT_DISABLED=1\nGH_HOST=github.com\n",
			);
			// What gh was asked about is exactly what was installed.
			expect(await readFile(join(fakeGhDirectory, "subject"))).toEqual(
				await readFile(join(installDirectory, "llm-tests-forge")),
			);
			const provenanceLines = finished.stdout
				.split("\n")
				.filter((line) => line.includes("rovenance"));
			expect(provenanceLines).toEqual([
				`Provenance verified: ${HOST.assetName} was built by ${SIGNER_WORKFLOW}`,
			]);
		}, 600_000);

		test("--version also pins the tag the attestation was built from (--source-ref), with or without its v", async () => {
			const { work, intactUrl } = await built();
			for (const version of ["1.2.3", "v1.2.3"]) {
				const fakeGhDirectory = await fakeGh("verified");
				const installDirectory = join(
					await mkdtemp(join(work, "target-")),
					"bin",
				);
				const finished = await runScript(
					["--dir", installDirectory, "--version", version],
					{ LLM_TESTS_FORGE_BASE_URL: intactUrl },
					fakeGhDirectory,
				);
				expect(finished.exitCode).toBe(0);
				const argumentsList = (
					await readFile(join(fakeGhDirectory, "arguments"), "utf8")
				)
					.trimEnd()
					.split("\n");
				expect(argumentsList.slice(3)).toEqual([
					"--repo",
					"albertosca/llm-tests-forge",
					"--signer-workflow",
					SIGNER_WORKFLOW,
					"--deny-self-hosted-runners",
					"--source-ref",
					"refs/tags/v1.2.3",
				]);
			}
		}, 600_000);

		for (const behavior of Object.keys(
			REFUSAL_HINTS,
		) as (keyof typeof REFUSAL_HINTS)[])
			test(`a verification gh refuses (${behavior}) refuses to install, naming the asset, gh's exit status, what gh said, what to check, and the skip escape`, async () => {
				const { work, intactUrl } = await built();
				if (HOST === undefined) throw new Error("this machine is not a target");
				const target = await mkdtemp(join(work, "target-"));
				const finished = await runScript(
					["--dir", join(target, "bin")],
					{ LLM_TESTS_FORGE_BASE_URL: intactUrl },
					await fakeGh(behavior),
				);
				const { exitCode, said } = FAKE_GH_ANSWERS[behavior];
				expect(finished.exitCode).toBe(1);
				expect(finished.stdout).not.toContain("Installed");
				const whatGhSaid =
					said === "" ? " gh printed nothing." : ` gh said:\n${said}`;
				expect(finished.stderr).toBe(
					`provenance check failed for ${HOST.assetName}: gh attestation verify exited ${exitCode}, so nothing proves it was built by ${SIGNER_WORKFLOW}; nothing was installed.${whatGhSaid}\n${REFUSAL_HINTS[behavior]}\n${SKIP_HINT}\n`,
				);
				expect(await readdir(target)).toEqual([]);
			}, 600_000);

		test("after --version, the skip escape fetches that release's install.sh and pins that release", async () => {
			const { work, intactUrl } = await built();
			if (HOST === undefined) throw new Error("this machine is not a target");
			const target = await mkdtemp(join(work, "target-"));
			const finished = await runScript(
				["--dir", join(target, "bin"), "--version", "1.2.3"],
				{ LLM_TESTS_FORGE_BASE_URL: intactUrl },
				await fakeGh("no-attestation"),
			);
			expect(finished.exitCode).toBe(1);
			expect(finished.stderr.trimEnd().split("\n").at(-1)).toBe(
				PINNED_SKIP_HINT,
			);
		}, 600_000);

		for (const behavior of [
			"probe-invalid-config",
			"probe-unreadable-config",
			"probe-config-not-a-directory",
			"probe-silent",
		] as const)
			test(`a gh whose probe fails for another reason than a missing command (${behavior}) refuses to install, saying what gh said`, async () => {
				const { work, intactUrl } = await built();
				if (HOST === undefined) throw new Error("this machine is not a target");
				const fakeGhDirectory = await fakeGh(behavior);
				const target = await mkdtemp(join(work, "target-"));
				const finished = await runScript(
					["--dir", join(target, "bin")],
					{ LLM_TESTS_FORGE_BASE_URL: intactUrl },
					fakeGhDirectory,
				);
				const { said } = FAKE_PROBE_ANSWERS[behavior];
				const whatGhSaid =
					said === "" ? " gh printed nothing." : ` gh said:\n${said}`;
				expect(finished.exitCode).toBe(1);
				expect(finished.stdout).not.toContain("Installed");
				expect(finished.stderr).toBe(
					`provenance check failed for ${HOST.assetName}: gh attestation verify --help exited 1, so this gh cannot check provenance; nothing was installed.${whatGhSaid}\n${BROKEN_GH_HINT}\n${SKIP_HINT}\n`,
				);
				expect(await readdir(target)).toEqual([]);
				// Nothing was asked to verify.
				expect(await readFile(join(fakeGhDirectory, "calls"), "utf8")).toBe(
					"attestation verify --help\n",
				);
			}, 600_000);

		test("a gh whose probe does not answer is stopped after LLM_TESTS_FORGE_GH_TIMEOUT seconds, and the install is refused", async () => {
			const { work, intactUrl } = await built();
			if (HOST === undefined) throw new Error("this machine is not a target");
			const fakeGhDirectory = await fakeGh("probe-hangs");
			const target = await mkdtemp(join(work, "target-"));
			const started = performance.now();
			const finished = await runScript(
				["--dir", join(target, "bin")],
				{
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					LLM_TESTS_FORGE_GH_TIMEOUT: "2",
				},
				fakeGhDirectory,
			);
			expect(performance.now() - started).toBeLessThan(30_000);
			expect(finished.exitCode).toBe(1);
			expect(finished.stderr).toBe(
				`provenance check failed for ${HOST.assetName}: gh attestation verify --help did not answer within 2 seconds; nothing was installed.\nCheck: gh hangs before it runs any command; run gh attestation verify --help to see where.\n${SKIP_HINT}\n`,
			);
			expect(await readdir(target)).toEqual([]);
			const ghProcess = Number(
				(await readFile(join(fakeGhDirectory, "pid"), "utf8")).trim(),
			);
			expect(ghProcess).toBeGreaterThan(1);
			expect(() => process.kill(ghProcess, 0)).toThrow();
		}, 600_000);

		test("a gh that does not answer is stopped after LLM_TESTS_FORGE_GH_TIMEOUT seconds, and the install is refused, naming the wait", async () => {
			const { work, intactUrl } = await built();
			if (HOST === undefined) throw new Error("this machine is not a target");
			const fakeGhDirectory = await fakeGh("hangs");
			const target = await mkdtemp(join(work, "target-"));
			const started = performance.now();
			const finished = await runScript(
				["--dir", join(target, "bin")],
				{
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					LLM_TESTS_FORGE_GH_TIMEOUT: "2",
				},
				fakeGhDirectory,
			);
			expect(performance.now() - started).toBeLessThan(30_000);
			expect(finished.exitCode).toBe(1);
			expect(finished.stderr).toBe(
				`provenance check failed for ${HOST.assetName}: gh attestation verify did not answer within 2 seconds; nothing was installed.\n${HOSTS_HINT}\n${SKIP_HINT}\n`,
			);
			expect(await readdir(target)).toEqual([]);
			// The hung gh was stopped, not left running.
			const ghProcess = Number(
				(await readFile(join(fakeGhDirectory, "pid"), "utf8")).trim(),
			);
			expect(() => process.kill(ghProcess, 0)).toThrow();
		}, 600_000);

		test("a TERM while gh verifies stops gh too, so no gh is left running after the script", async () => {
			const { work, intactUrl } = await built();
			const fakeGhDirectory = await fakeGh("hangs");
			const target = await mkdtemp(join(work, "target-"));
			const child = Bun.spawn(
				[INSTALL_SHELL, INSTALL_SCRIPT, "--dir", join(target, "bin")],
				{
					cwd: REPOSITORY,
					env: {
						...process.env,
						LLM_TESTS_FORGE_BASE_URL: intactUrl,
						PATH: `${fakeGhDirectory}:${process.env.PATH ?? ""}`,
					},
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			// The file can exist before the pid is in it, and Number("") is 0,
			// which process.kill reads as the whole process group: wait for the
			// newline that ends the pid.
			const pidFile = join(fakeGhDirectory, "pid");
			const readPid = () => readFile(pidFile, "utf8").catch(() => "");
			const deadline = performance.now() + 60_000;
			while (!(await readPid()).endsWith("\n") && performance.now() < deadline)
				await Bun.sleep(50);
			const ghProcess = Number((await readPid()).trim());
			expect(ghProcess).toBeGreaterThan(1);
			child.kill("SIGTERM");
			expect(await child.exited).toBe(143);
			// Signalled gh exits, then the system reaps it: allow it a moment.
			const isRunning = () => {
				try {
					process.kill(ghProcess, 0);
					return true;
				} catch {
					return false;
				}
			};
			const reapDeadline = performance.now() + 5_000;
			while (isRunning() && performance.now() < reapDeadline)
				await Bun.sleep(50);
			expect(isRunning()).toBe(false);
			expect(await readdir(target)).toEqual([]);
		}, 600_000);

		test("an LLM_TESTS_FORGE_GH_TIMEOUT that is not a whole number of seconds is refused before downloading", async () => {
			const { work, intactUrl } = await built();
			const target = await mkdtemp(join(work, "target-"));
			for (const value of ["", "abc", "0", "-1", "1.5"]) {
				const finished = await runScript(["--dir", join(target, "bin")], {
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					LLM_TESTS_FORGE_GH_TIMEOUT: value,
				});
				expect({ value, ...finished }).toEqual({
					value,
					exitCode: 2,
					stdout: "",
					stderr: `LLM_TESTS_FORGE_GH_TIMEOUT must be a whole number of seconds above 0, not '${value}'\n`,
				});
			}
			expect(await readdir(target)).toEqual([]);
		}, 600_000);

		for (const behavior of ["too-old", "too-old-on-stdout"] as const)
			test(`a gh without the attestation command (before 2.49; ${behavior}) is treated as no gh: the binary is installed on its checksum, and stderr says which gh can check it, and how`, async () => {
				const { work, intactUrl } = await built();
				const fakeGhDirectory = await fakeGh(behavior);
				const installDirectory = join(
					await mkdtemp(join(work, "target-")),
					"bin",
				);
				const installedPath = join(installDirectory, "llm-tests-forge");
				const finished = await runScript(
					["--dir", installDirectory],
					{ LLM_TESTS_FORGE_BASE_URL: intactUrl },
					fakeGhDirectory,
				);
				expect(finished.exitCode).toBe(0);
				expect(finished.stdout).toContain(`Installed ${installedPath}`);
				expect(finished.stderr).toBe(
					`provenance not checked: this gh has no attestation command (gh 2.49 or newer has it); the binary matched SHA256SUMS, which proves it arrived intact, not who built it. To check it after upgrading gh: ${verifyCommand(installedPath)}\n`,
				);
				// Only the probe ran: nothing was asked to verify.
				expect(await readFile(join(fakeGhDirectory, "calls"), "utf8")).toBe(
					"attestation verify --help\n",
				);
			}, 600_000);

		test("LLM_TESTS_FORGE_PROVENANCE=skip installs on the checksum alone without asking gh, and warns loudly; any other value is refused before downloading", async () => {
			const { work, intactUrl } = await built();
			const fakeGhDirectory = await fakeGh("no-attestation");
			const installDirectory = join(
				await mkdtemp(join(work, "target-")),
				"bin",
			);
			const installedPath = join(installDirectory, "llm-tests-forge");
			const finished = await runScript(
				["--dir", installDirectory],
				{
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					LLM_TESTS_FORGE_PROVENANCE: "skip",
				},
				fakeGhDirectory,
			);
			expect(finished.exitCode).toBe(0);
			expect(finished.stdout).toContain(`Installed ${installedPath}`);
			expect(finished.stderr).toBe(
				`WARNING: provenance NOT checked (LLM_TESTS_FORGE_PROVENANCE=skip): the binary matched SHA256SUMS, which proves it arrived intact, not who built it. To check it: ${verifyCommand(installedPath)}\n`,
			);
			expect(await Bun.file(join(fakeGhDirectory, "calls")).exists()).toBe(
				false,
			);
			const target = await mkdtemp(join(work, "target-"));
			for (const value of ["SKIP", "no", "1"]) {
				const refused = await runScript(["--dir", join(target, "bin")], {
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					LLM_TESTS_FORGE_PROVENANCE: value,
				});
				expect({ value, ...refused }).toEqual({
					value,
					exitCode: 2,
					stdout: "",
					stderr: `LLM_TESTS_FORGE_PROVENANCE must be unset or skip, not '${value}'\n`,
				});
			}
			expect(await readdir(target)).toEqual([]);
		}, 600_000);

		test("with no gh on the PATH, the binary is installed on its checksum, and stderr says provenance was not checked and how to check it", async () => {
			const { work, intactUrl } = await built();
			const installDirectory = join(
				await mkdtemp(join(work, "target-")),
				"bin",
			);
			const installedPath = join(installDirectory, "llm-tests-forge");
			const finished = await runScript(
				["--dir", installDirectory],
				{
					LLM_TESTS_FORGE_BASE_URL: intactUrl,
					PATH: await toolsWithoutGh(work),
				},
				await mkdtemp(join(work, "no-gh-")),
			);
			expect(finished.exitCode).toBe(0);
			expect(finished.stdout).toContain(`Installed ${installedPath}`);
			expect(finished.stderr).toBe(
				`provenance not checked: gh (the GitHub CLI, https://cli.github.com) is not installed; the binary matched SHA256SUMS, which proves it arrived intact, not who built it. To check it with gh 2.49 or newer: ${verifyCommand(installedPath)}\n`,
			);
		}, 600_000);
	},
);

describe.skipIf(!packages || HOST === undefined)("install.sh", () => {
	test("downloads the host binary, verifies it, installs it executable into --dir and says where and whether it is on the PATH", async () => {
		const { work, intactUrl } = await built();
		const target = await mkdtemp(join(work, "target-"));
		const installDirectory = join(target, "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
		});
		expect(finished.stderr).toBe("");
		expect(finished.exitCode).toBe(0);
		const installedPath = join(installDirectory, "llm-tests-forge");
		expect(finished.stdout).toContain(`Installed ${installedPath}`);
		expect(finished.stdout).toContain(
			`${installDirectory} is not on your PATH`,
		);
		expect((await stat(installedPath)).mode & 0o777).toBe(0o755);
		expect(await readdir(installDirectory)).toEqual(["llm-tests-forge"]);
		const version = Bun.spawn([installedPath, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(version.stdout).text()).toBe(
			`${FORGE_VERSION}\n`,
		);
		expect(await version.exited).toBe(0);
		// The same directory on the PATH is reported as such, and a second run replaces the binary.
		const again = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
			PATH: `${installDirectory}:${process.env.PATH ?? ""}`,
		});
		expect(again.exitCode).toBe(0);
		expect(again.stdout).toContain(`${installDirectory} is on your PATH.`);
	}, 600_000);

	test("a corrupted download is refused, naming the asset, and nothing is installed", async () => {
		const { work, corruptedUrl } = await built();
		const target = await mkdtemp(join(work, "target-"));
		const installDirectory = join(target, "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: corruptedUrl,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`checksum mismatch for ${HOST?.assetName}`,
		);
		expect(finished.stderr).toContain("nothing was installed");
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("a SHA256SUMS that does not list the asset is refused, and a name that only contains it does not count", async () => {
		const { work } = await built();
		if (HOST === undefined) throw new Error("this machine is not a target");
		const served = await mkdtemp(join(work, "served-"));
		await writeFile(join(served, HOST.assetName), "not a real binary");
		await writeFile(
			join(served, "SHA256SUMS"),
			`${"0".repeat(64)}  ${HOST.assetName}.exe\n${"0".repeat(64)}  x${HOST.assetName}\n`,
		);
		const target = await mkdtemp(join(work, "target-"));
		const finished = await runScript(["--dir", join(target, "bin")], {
			LLM_TESTS_FORGE_BASE_URL: serve(served, false),
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`SHA256SUMS does not list ${HOST.assetName}`,
		);
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("an unsupported platform exits 1 naming what uname returned and the asset it would have wanted, and installs nothing", async () => {
		const { work, intactUrl } = await built();
		for (const [kernelName, machineName, expected] of [
			["FreeBSD", "amd64", "freebsd-x64"],
			// Every 32-bit x86 is ia32, as npm, the wheel, the gem and Hex name it.
			["Linux", "i686", "linux-ia32"],
			["Linux", "i386", "linux-ia32"],
			["Linux", "x86", "linux-ia32"],
			["MINGW64_NT-10.0", "x86_64", "mingw64_nt-10.0-x64"],
		] as const) {
			const target = await mkdtemp(join(work, "target-"));
			const fake = await fakeUname(work, kernelName, machineName);
			const finished = await runScript(["--dir", join(target, "bin")], {
				LLM_TESTS_FORGE_BASE_URL: intactUrl,
				PATH: `${fake}:${process.env.PATH ?? ""}`,
			});
			expect(finished.exitCode).toBe(1);
			expect(finished.stderr).toBe(
				`llm-tests-forge has no binary for ${kernelName} ${machineName} (uname -s, uname -m): the release has no asset llm-tests-forge-${expected}; see https://github.com/albertosca/llm-tests-forge\n`,
			);
			expect(await readdir(target)).toEqual([]);
		}
	}, 600_000);

	test("a Linux ARM machine maps to the linux-arm64 asset (a fake uname, and a server holding nothing, so the download is refused on every host)", async () => {
		const { work } = await built();
		const emptyUrl = serve(await mkdtemp(join(work, "served-empty-")), false);
		const target = await mkdtemp(join(work, "target-"));
		const fake = await fakeUname(work, "Linux", "aarch64");
		const finished = await runScript(["--dir", join(target, "bin")], {
			LLM_TESTS_FORGE_BASE_URL: emptyUrl,
			PATH: `${fake}:${process.env.PATH ?? ""}`,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stdout).toContain(
			`${emptyUrl}/llm-tests-forge-linux-arm64`,
		);
		expect(finished.stderr).toContain(
			`cannot download ${emptyUrl}/llm-tests-forge-linux-arm64`,
		);
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("on musl Linux (ldd --version names musl, as rustup-init.sh reads it) install.sh refuses before downloading, saying musl has no binary yet", async () => {
		const { work, intactUrl } = await built();
		for (const [machineName, name] of [
			["x86_64", "linux-x64"],
			["aarch64", "linux-arm64"],
		] as const) {
			const target = await mkdtemp(join(work, "target-"));
			const finished = await runScript(["--dir", join(target, "bin")], {
				LLM_TESTS_FORGE_BASE_URL: intactUrl,
				LLM_TESTS_FORGE_LIBRARY_DIRECTORY: await mkdtemp(join(work, "lib-")),
				PATH: `${await fakeUname(work, "Linux", machineName)}:${await fakeLdd(work, "musl")}:${process.env.PATH ?? ""}`,
			});
			expect(finished).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `${muslMessage(name)}\n`,
			});
			expect(await readdir(target)).toEqual([]);
		}
	}, 600_000);

	test("on musl Linux without a telling ldd, musl's loader (/lib/ld-musl-*) is enough to refuse", async () => {
		const { work, intactUrl } = await built();
		const library = await mkdtemp(join(work, "lib-"));
		await writeFile(join(library, "ld-musl-x86_64.so.1"), "");
		const target = await mkdtemp(join(work, "target-"));
		const finished = await runScript(["--dir", join(target, "bin")], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
			LLM_TESTS_FORGE_LIBRARY_DIRECTORY: library,
			PATH: `${await fakeUname(work, "Linux", "x86_64")}:${await fakeLdd(work, "missing")}:${process.env.PATH ?? ""}`,
		});
		expect(finished).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${muslMessage("linux-x64")}\n`,
		});
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("an ldd that names glibc is decisive, even beside a musl loader (Debian with the musl package); with no answer from ldd and no loader, install.sh goes on too", async () => {
		const { work } = await built();
		const emptyUrl = serve(await mkdtemp(join(work, "served-empty-")), false);
		// [what ldd --version says, whether /lib holds a musl loader]
		const cases: [FakeLibc, boolean][] = [
			["glibc", false],
			["glibc", true],
			["debian-glibc", true],
			["missing", false],
		];
		for (const [libc, loaderPresent] of cases) {
			const library = await mkdtemp(join(work, "lib-"));
			if (loaderPresent)
				await writeFile(join(library, "ld-musl-x86_64.so.1"), "");
			const target = await mkdtemp(join(work, "target-"));
			const finished = await runScript(["--dir", join(target, "bin")], {
				LLM_TESTS_FORGE_BASE_URL: emptyUrl,
				LLM_TESTS_FORGE_LIBRARY_DIRECTORY: library,
				PATH: `${await fakeUname(work, "Linux", "x86_64")}:${await fakeLdd(work, libc)}:${process.env.PATH ?? ""}`,
			});
			// A server holding nothing, so the download is where it stops.
			expect({
				libc,
				loaderPresent,
				exitCode: finished.exitCode,
				downloaded: finished.stderr.includes(
					`cannot download ${emptyUrl}/llm-tests-forge-linux-x64\n`,
				),
				musl: finished.stderr.includes("musl"),
			}).toEqual({
				libc,
				loaderPresent,
				exitCode: 1,
				downloaded: true,
				musl: false,
			});
		}
	}, 600_000);

	test("a directory where the binary goes is refused naming it, and nothing is moved into it", async () => {
		const { work, intactUrl } = await built();
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		const occupied = join(installDirectory, "llm-tests-forge");
		await mkdir(occupied, { recursive: true });
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`${occupied} is a directory; remove it or choose another --dir; nothing was installed`,
		);
		expect(finished.stdout).not.toContain("Installed");
		expect(await readdir(occupied)).toEqual([]);
		expect(await readdir(installDirectory)).toEqual(["llm-tests-forge"]);
	}, 600_000);

	test("a SHA256SUMS line in binary mode (hash *name, as sha256sum -b writes it) is accepted", async () => {
		const { work } = await built();
		if (HOST === undefined) throw new Error("this machine is not a target");
		const served = await mkdtemp(join(work, "served-"));
		const content = "a stand-in binary\n";
		await writeFile(join(served, HOST.assetName), content);
		const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
		await writeFile(join(served, "SHA256SUMS"), `${hash} *${HOST.assetName}\n`);
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: serve(served, false),
		});
		expect(finished.stderr).toBe("");
		expect(finished.exitCode).toBe(0);
		expect(
			await Bun.file(join(installDirectory, "llm-tests-forge")).text(),
		).toBe(content);
	}, 600_000);

	test("a TERM that arrives while the binary is being put in place removes the temporary copy and stops the script", async () => {
		const { work, intactUrl } = await built();
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		// A fake mv first on the PATH: it signals the script that ran it and moves nothing,
		// so the copy beside the target is exactly what an interrupted install leaves.
		const fakeMoveDirectory = await mkdtemp(join(work, "fake-mv-"));
		await writeFile(
			join(fakeMoveDirectory, "mv"),
			'#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n',
		);
		await chmod(join(fakeMoveDirectory, "mv"), 0o755);
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
			PATH: `${fakeMoveDirectory}:${process.env.PATH ?? ""}`,
		});
		expect(finished.exitCode).toBe(143);
		expect(finished.stdout).not.toContain("Installed");
		expect(await readdir(installDirectory)).toEqual([]);
	}, 600_000);

	test("--version picks the release path, an unknown option is a usage error (exit 2), and --dir without a value too", async () => {
		const { work } = await built();
		const target = await mkdtemp(join(work, "target-"));
		// A fake curl first on the PATH records the URL it is asked for and fails, so the real network is never touched.
		const fakeCurlDirectory = await mkdtemp(join(work, "fake-curl-"));
		const requestedPath = join(fakeCurlDirectory, "requested");
		const fakeCurl = join(fakeCurlDirectory, "curl");
		await writeFile(
			fakeCurl,
			`#!/bin/sh\nfor argument; do last="$argument"; done\necho "$last" >> "${requestedPath}"\nexit 22\n`,
		);
		await chmod(fakeCurl, 0o755);
		const environment = {
			PATH: `${fakeCurlDirectory}:${process.env.PATH ?? ""}`,
		};
		const tagged = await runScript(
			["--dir", join(target, "bin"), "--version", "1.2.3"],
			environment,
		);
		expect(tagged.exitCode).toBe(1);
		expect(await Bun.file(requestedPath).text()).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/download/v1.2.3/${HOST?.assetName}\n`,
		);
		await rm(requestedPath);
		const latest = await runScript(["--dir", join(target, "bin")], environment);
		expect(latest.exitCode).toBe(1);
		expect(await Bun.file(requestedPath).text()).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/latest/download/${HOST?.assetName}\n`,
		);
		for (const argumentsList of [["--bogus"], ["--dir"], ["--version"]]) {
			const finished = await runScript(argumentsList, {});
			expect(finished.exitCode).toBe(2);
			expect(finished.stderr).toContain("usage: install.sh");
		}
		expect(await readdir(target)).toEqual([]);
	}, 600_000);
});
