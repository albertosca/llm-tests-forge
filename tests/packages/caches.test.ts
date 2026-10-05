/**
 * The package tests run npm and uv, whose caches default to the home
 * directory (`~/.npm`, `~/.cache/uv`). The packages preload points npm's
 * under the run's private TMPDIR, and uv's at the repository's gitignored
 * `node_modules/.cache/forge-uv`, kept across runs so hatchling is not
 * downloaded again; a run leaves nothing in the home caches. This checks
 * what the tools themselves report, and that a wheel builds with no
 * network once the cache holds hatchling. Off by default; run with `bun run
 * test:packages` (sets FORGE_PACKAGES=1).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { REPOSITORY } from "../helpers/repository";

const packages = process.env.FORGE_PACKAGES === "1";
const UV_CACHE = join(REPOSITORY, "node_modules/.cache/forge-uv");

function reported(
	command: string[],
	extraEnvironment: Record<string, string> = {},
): string {
	// A FORCE_COLOR the shell exports makes uv colour even a pipe.
	const { FORCE_COLOR: _forced, ...environment } = process.env;
	const child = Bun.spawnSync(command, {
		cwd: REPOSITORY,
		env: { ...environment, NO_COLOR: "1", ...extraEnvironment },
	});
	if (child.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} exited ${child.exitCode}: ${child.stderr.toString()}`,
		);
	return child.stdout.toString().trim();
}

describe.skipIf(!packages)("the package tests' caches", () => {
	test("npm reports its cache under the run's TMPDIR", () => {
		const runRoot = tmpdir();
		expect(runRoot).toContain("forge-test-run-");
		expect(process.env.npm_config_cache).toBe(join(runRoot, "npm-cache"));
		expect(reported(["npm", "config", "get", "cache"])).toBe(
			join(runRoot, "npm-cache"),
		);
	}, 30_000);

	test("uv reports its cache at the repository's node_modules/.cache/forge-uv, which git ignores and which is not the home cache", () => {
		expect(process.env.UV_CACHE_DIR).toBe(UV_CACHE);
		expect(reported(["uv", "cache", "dir"])).toBe(UV_CACHE);
		expect(UV_CACHE.startsWith(join(homedir(), ".cache"))).toBe(false);
		// check-ignore prints the path when it is ignored, and exits 1 when not.
		expect(
			reported([
				"git",
				"check-ignore",
				"--no-index",
				"node_modules/.cache/forge-uv/x",
			]),
		).toBe("node_modules/.cache/forge-uv/x");
	}, 30_000);

	test("once the cache holds hatchling, a wheel builds with no network", async () => {
		const work = await mkdtemp(join(tmpdir(), "forge-uv-offline-"));
		const binary = join(work, "llm-tests-forge");
		await writeFile(binary, "a stand-in binary\n");
		const build = (offline: boolean) =>
			reported(
				[
					"uv",
					"build",
					"--wheel",
					"--out-dir",
					join(work, offline ? "offline" : "online"),
					join(REPOSITORY, "packages/pypi"),
				],
				{
					FORGE_WHEEL_PLATFORM: "manylinux_2_17_x86_64",
					FORGE_WHEEL_BINARY: binary,
					...(offline ? { UV_OFFLINE: "1" } : {}),
				},
			);
		// The first build fills the cache when it is empty (the network is
		// allowed); the second must find everything there.
		build(false);
		expect(() => build(true)).not.toThrow();
	}, 120_000);
});
