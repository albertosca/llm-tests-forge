import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The bun runner passes testFiles to `bun test` verbatim: no glob expansion,
// and a bare name is a filter, so every file is listed as ./paths. The list
// is read from disk (recursively) so a new core test joins it on its own;
// tests/mutation/stryker-config.test.ts fails if this list and the files on
// disk ever disagree, because a test file missing here leaves its mutants
// unkilled without any error. The directory is found from this file, so the
// list is the same whatever directory imports the config.
const coreTests = readdirSync(
	fileURLToPath(new URL("./tests/core", import.meta.url)),
	{ recursive: true },
)
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => `./tests/core/${name}`)
	.sort();

// The checker runs in its own Node process, which needs the same resolve
// hook as the `mutation` script (the file says why). An absolute URL, so the
// process's working directory does not matter.
const typescriptHook = new URL(
	"./scripts/mutation/stryker-typescript.mjs",
	import.meta.url,
).href;

export default {
	// Naming plugins replaces Stryker's default (every @stryker-mutator/*
	// package), so the checker is listed too. Without the bun runner here the
	// `bun` option below is reported as unknown and the runner never starts.
	plugins: [
		"@hughescr/stryker-bun-runner",
		"@stryker-mutator/typescript-checker",
	],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	mutate: ["src/core/**/*.ts"],
	bun: { testFiles: coreTests },
	// Every mutant in src/core is killed or disabled with its reason (100.00%
	// on 2026-09-30), so one new survivor or uncovered mutant fails the run.
	thresholds: { high: 90, low: 80, break: 100 },
	reporters: ["clear-text", "json"],
	// A mutant that does not compile is a CompileError, never Killed or
	// Survived. The native mode compiles with the project's TypeScript 7, so
	// a mutant is judged by the compiler `bun run typecheck` runs; it checks
	// mutants one at a time and does not support project references.
	// tsconfig.stryker.json narrows the check to src, where every mutant
	// lives: measured on report.ts, the same 238 CompileErrors in half the time
	// of checking tests and scripts as well. The tests' own types stay with
	// `bun run typecheck`.
	checkers: ["typescript"],
	typescriptChecker: { experimentalNativePreview: true },
	checkerNodeArgs: ["--import", typescriptHook],
	tsconfigFile: "tsconfig.stryker.json",
};
