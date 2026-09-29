/**
 * The package tests run npm and uv, whose caches default to the home
 * directory (`~/.npm`, `~/.cache/uv`). The packages preload points both
 * under the run's private TMPDIR, so a run leaves nothing in the home
 * caches; this checks what the tools themselves report. Off by default; run
 * with `bun run test:packages` (sets FORGE_PACKAGES=1).
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = process.env.FORGE_PACKAGES === "1";

function reported(command: string[]): string {
	const child = Bun.spawnSync(command, { env: process.env });
	if (child.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} exited ${child.exitCode}: ${child.stderr.toString()}`,
		);
	return child.stdout.toString().trim();
}

describe.skipIf(!packages)("the package tests' caches", () => {
	test("npm and uv, run as the package tests run them, report caches under the run's TMPDIR", () => {
		const runRoot = tmpdir();
		expect(runRoot).toContain("forge-test-run-");
		expect(process.env.npm_config_cache).toBe(join(runRoot, "npm-cache"));
		expect(process.env.UV_CACHE_DIR).toBe(join(runRoot, "uv-cache"));
		expect(reported(["npm", "config", "get", "cache"])).toBe(
			join(runRoot, "npm-cache"),
		);
		expect(reported(["uv", "cache", "dir"])).toBe(join(runRoot, "uv-cache"));
	});
});
