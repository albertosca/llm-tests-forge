/**
 * The Homebrew formula, end to end: the host binary compiled, SHA256SUMS
 * written, the formula rendered against a local server, then installed from a
 * temporary tap (`brew tap-new`, because Homebrew 7 refuses a formula outside
 * a tap), tested with `brew test` and run. The tap and the formula are removed
 * in a `finally`, and the taps and installed formulae are listed before and
 * after to prove nothing else in the real Homebrew changed. Off by default;
 * run with `bun run test:packages` (sets FORGE_PACKAGES=1). It needs `brew`
 * on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { writeChecksums } from "../../scripts/release/checksums";
import { renderFormula } from "../../scripts/release/homebrew-formula";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
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

/** Homebrew's own cache is redirected to `cache` so the download this test triggers never lands in the real one. */
function brewEnvironment(cache: string): Record<string, string> {
	return {
		HOMEBREW_CACHE: cache,
		HOMEBREW_NO_AUTO_UPDATE: "1",
		HOMEBREW_NO_INSTALL_CLEANUP: "1",
		HOMEBREW_NO_ANALYTICS: "1",
		HOMEBREW_NO_ENV_HINTS: "1",
	};
}

async function brew(argumentsList: string[], cache: string): Promise<Finished> {
	const child = Bun.spawn(["brew", ...argumentsList], {
		cwd: REPOSITORY,
		env: { ...process.env, ...brewEnvironment(cache) },
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

/** How the tests run brew: the real one, or a seam around it that fakes a failure. */
type BrewRunner = (argumentsList: string[], cache: string) => Promise<Finished>;

async function mustBrew(
	argumentsList: string[],
	cache: string,
	runBrew: BrewRunner = brew,
): Promise<string> {
	const finished = await runBrew(argumentsList, cache);
	if (finished.exitCode !== 0)
		throw new Error(
			`brew ${argumentsList.join(" ")} exited ${finished.exitCode}: ${finished.stderr}`,
		);
	return finished.stdout;
}

/**
 * Installs the formula at `formulaPath` from a new temporary tap, runs `brew
 * test` and returns the installed prefix; then, always, uninstalls it and
 * removes the tap. `runBrew` exists for the test that fails a step halfway.
 */
async function installFromTemporaryTap(
	tapName: string,
	formulaPath: string,
	cache: string,
	whileInstalled: (prefix: string) => Promise<void>,
	runBrew: BrewRunner = brew,
): Promise<void> {
	const formulaName = `${tapName}/llm-tests-forge`;
	try {
		await mustBrew(["tap-new", "--no-git", tapName], cache, runBrew);
		const tapDirectory = (
			await mustBrew(["--repository", tapName], cache, runBrew)
		).trim();
		await copyFile(
			formulaPath,
			join(tapDirectory, "Formula", "llm-tests-forge.rb"),
		);
		await mustBrew(["install", formulaName], cache, runBrew);
		await mustBrew(["test", formulaName], cache, runBrew);
		await whileInstalled(
			(await mustBrew(["--prefix", formulaName], cache, runBrew)).trim(),
		);
	} finally {
		// Always, even when tap-new failed: one that fails halfway can leave the
		// tap behind. Both names are this test's own (a random tap), so neither
		// command can touch anything else, and brew() does not throw when there
		// is nothing to remove.
		await brew(["uninstall", "--force", formulaName], cache);
		await brew(["untap", "--force", tapName], cache);
	}
}

/** A tap name no one else uses. */
function temporaryTapName(): string {
	return `forge-e2e-${crypto.randomUUID().slice(0, 8)}/test`;
}

/** What a stray tap or formula would change: the tap list and the installed formulae. */
async function homebrewState(cache: string): Promise<string> {
	const taps = await mustBrew(["tap"], cache);
	const formulae = await mustBrew(["list", "--formula", "--versions"], cache);
	return `taps:\n${taps}formulae:\n${formulae}`;
}

const workDirectories: string[] = [];
const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(async () => {
	for (const server of servers) await server.stop(true);
	for (const directory of workDirectories)
		await rm(directory, { recursive: true, force: true });
});

// A Linux CI runner carries no brew on its PATH, and installing Homebrew there
// to test the formula is not worth its minutes: the test is skipped, and says so.
const BREW_MISSING = Bun.which("brew") === null;

describe.skipIf(!packages || HOST === undefined || BREW_MISSING)(
	`homebrew formula${BREW_MISSING ? " (skipped: brew is not on the PATH)" : ""}`,
	() => {
		test("installs from a temporary tap, passes brew test, runs, and leaves Homebrew as it found it", async () => {
			if (HOST === undefined) throw new Error("this machine is not a target");
			const work = await mkdtemp(join(tmpdir(), "forge-brew-e2e-"));
			workDirectories.push(work);
			const cache = join(work, "cache");
			const binaries = join(work, "binaries");
			await buildBinaries(binaries, HOST.bunTarget);
			// The other targets get small stand-ins: the formula lists every Homebrew asset, and only the host's is downloaded.
			for (const target of RELEASE_TARGETS)
				if (target !== HOST && target.homebrew !== null)
					await writeFile(join(binaries, target.assetName), target.assetName);
			const sumsText = await writeChecksums(binaries);
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(request) {
					const name = new URL(request.url).pathname.slice(1);
					const file = Bun.file(join(binaries, name));
					if (name === "" || name.includes("/") || !(await file.exists()))
						return new Response("not found", { status: 404 });
					return new Response(file);
				},
			});
			servers.push(server);
			const formula = await renderFormula(
				FORGE_VERSION,
				sumsText,
				join(binaries, "SHA256SUMS"),
				`http://127.0.0.1:${server.port}`,
			);
			const formulaPath = join(work, "llm-tests-forge.rb");
			await writeFile(formulaPath, formula);

			const before = await homebrewState(cache);
			await installFromTemporaryTap(
				temporaryTapName(),
				formulaPath,
				cache,
				async (prefix) => {
					const run = Bun.spawn(
						[join(prefix, "bin", "llm-tests-forge"), "--version"],
						{
							stdout: "pipe",
							stderr: "pipe",
						},
					);
					expect(await new Response(run.stdout).text()).toBe(
						`${FORGE_VERSION}\n`,
					);
					expect(await run.exited).toBe(0);
				},
			);
			expect(await homebrewState(cache)).toBe(before);
		}, 600_000);

		test("a tap-new that fails after creating the tap still leaves Homebrew as it found it", async () => {
			const work = await mkdtemp(join(tmpdir(), "forge-brew-partial-"));
			workDirectories.push(work);
			const cache = join(work, "cache");
			const before = await homebrewState(cache);
			const tapName = temporaryTapName();
			let tapsAfterTapNew = "";
			// The real tap-new runs and creates the tap, then reports a failure.
			const failingAfterTapNew: BrewRunner = async (
				argumentsList,
				brewCache,
			) => {
				const finished = await brew(argumentsList, brewCache);
				if (argumentsList[0] !== "tap-new") return finished;
				tapsAfterTapNew = await mustBrew(["tap"], brewCache);
				return { ...finished, exitCode: 1, stderr: "failed halfway" };
			};
			await expect(
				installFromTemporaryTap(
					tapName,
					join(work, "never-read.rb"),
					cache,
					async () => {},
					failingAfterTapNew,
				),
			).rejects.toThrow(`brew tap-new --no-git ${tapName} exited 1`);
			// The tap was really there when tap-new failed, and is gone now.
			expect(tapsAfterTapNew.split("\n")).toContain(tapName);
			expect(await homebrewState(cache)).toBe(before);
		}, 600_000);
	},
);
