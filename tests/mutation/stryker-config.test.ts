import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");

// Stryker's bun runner takes an explicit file list; a core test left off it
// kills no mutants and raises no error.
test("stryker lists every test file under tests/core, nested ones included", async () => {
	const config: { bun: { testFiles: string[] } } = (
		await import(join(REPOSITORY, "stryker.config.mjs"))
	).default;
	const onDisk = [
		...new Bun.Glob("**/*.test.ts").scanSync({
			cwd: join(REPOSITORY, "tests/core"),
		}),
	]
		.map((name) => `./tests/core/${name}`)
		.sort();
	expect(onDisk.length).toBeGreaterThan(0);
	expect([...config.bun.testFiles].sort()).toEqual(onDisk);
});

/** `git check-ignore`'s answer for a path that need not exist: 0 ignored, 1 not ignored (anything else is an error, not an answer). */
function ignoreStatus(path: string): number {
	return Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", path], {
		cwd: REPOSITORY,
	}).exitCode;
}

test("Stryker's report and sandbox are ignored at the root only, so a reports/ directory deeper in the tree is not", () => {
	expect(ignoreStatus("reports/mutation/mutation.json")).toBe(0);
	expect(ignoreStatus(".stryker-tmp/sandbox-1/package.json")).toBe(0);
	expect(ignoreStatus("examples/some-suite/reports/summary.md")).toBe(1);
	expect(ignoreStatus("src/report/.stryker-tmp/notes.md")).toBe(1);
});
