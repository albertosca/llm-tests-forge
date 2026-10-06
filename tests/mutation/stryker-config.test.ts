import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

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

const CheckerConfigSchema = z.object({
	plugins: z.array(z.string()),
	checkers: z.array(z.string()),
	typescriptChecker: z.object({ experimentalNativePreview: z.boolean() }),
	checkerNodeArgs: z.array(z.string()),
	tsconfigFile: z.string(),
});

// Without a checker, a mutant that does not compile is scored Killed or
// Survived by whatever the test run does with it.
test("Stryker type-checks every mutant: the TypeScript checker, in native mode, on a tsconfig that exists, with the resolve hook in the checker's process", async () => {
	const config = CheckerConfigSchema.parse(
		(await import(join(REPOSITORY, "stryker.config.mjs"))).default,
	);
	expect(config.plugins).toContain("@stryker-mutator/typescript-checker");
	expect(config.checkers).toEqual(["typescript"]);
	expect(config.typescriptChecker.experimentalNativePreview).toBe(true);
	expect(existsSync(join(REPOSITORY, config.tsconfigFile))).toBe(true);
	expect(config.tsconfigFile).toBe("tsconfig.stryker.json");
	const narrowed = z
		.object({ extends: z.string(), include: z.array(z.string()) })
		.parse(
			JSON.parse(readFileSync(join(REPOSITORY, config.tsconfigFile), "utf8")),
		);
	expect(narrowed).toEqual({ extends: "./tsconfig.json", include: ["src"] });
	const hook = join(REPOSITORY, "scripts/mutation/stryker-typescript.mjs");
	expect(config.checkerNodeArgs).toEqual([
		"--import",
		pathToFileURL(hook).href,
	]);
	expect(existsSync(hook)).toBe(true);
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
}, 30_000);
