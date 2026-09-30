import { readdirSync } from "node:fs";

// The bun runner passes testFiles to `bun test` verbatim: no glob expansion,
// and a bare name is a filter, so every file is listed as ./paths. The list
// is read from disk (recursively) so a new core test joins it on its own;
// tests/mutation/stryker-config.test.ts fails if this list and the files on
// disk ever disagree, because a test file missing here leaves its mutants
// unkilled without any error.
const coreTests = readdirSync("tests/core", { recursive: true })
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => `./tests/core/${name}`)
	.sort();

export default {
	// Stryker auto-loads only @stryker-mutator/* plugins; without this line the
	// `bun` option below is reported as unknown and the runner never starts.
	plugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	mutate: ["src/core/**/*.ts"],
	bun: { testFiles: coreTests },
	// Every mutant in src/core is killed or disabled with its reason (100.00%
	// on 2026-09-30), so one new survivor or uncovered mutant fails the run.
	thresholds: { high: 90, low: 80, break: 100 },
	reporters: ["clear-text", "json"],
	// TypeScript 7 (the Go port) has no JS API, so Stryker's tsconfig rewrite
	// (ts.parseConfigFileTextToJson) crashes. This tsconfig has no extends or
	// references to rewrite; naming a file that does not exist skips it. If a
	// future Stryker needs the TypeScript API for anything else, this breaks.
	tsconfigFile: "stryker-skips-tsconfig-rewrite.json",
};
