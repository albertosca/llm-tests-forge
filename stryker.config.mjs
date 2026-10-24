import {
	mutateFromEnvironment,
	reportFileName,
	SCOPES,
	scopeFromEnvironment,
	testFilesOf,
} from "./scripts/mutation/scopes.mjs";

// One Stryker run covers one scope (scripts/mutation/scopes.mjs says what a
// scope is): `bun run mutation <scope>` puts its name in STRYKER_SCOPE, and
// no name means core. The bun runner passes testFiles to `bun test`
// verbatim, so the scope's list is built there as ./paths;
// tests/mutation/stryker-config.test.ts fails if a list and the files on
// disk ever disagree, because a test file missing from it leaves its mutants
// unkilled without any error.
const scopeName = scopeFromEnvironment(process.env);
const scope = SCOPES[scopeName];

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
	// docs/superpowers is a gitignored symlink to the private docs repo on
	// the maintainer's machine; the sandbox copy follows it and dies on a
	// file it cannot copy (ENOTSUP). Nothing in docs is a test or a mutant.
	ignorePatterns: ["docs"],
	// One worker: with the default (one per core) the native compilers alone
	// took the maintainer's machine to a load of 35, and two still hurt.
	concurrency: 1,
	coverageAnalysis: "perTest",
	// STRYKER_MUTATE_FILE (`bun run mutation <scope> --mutate <file>`) narrows
	// the mutated files to one; the tests stay the scope's whole list.
	mutate: mutateFromEnvironment(scopeName, process.env),
	bun: { testFiles: testFilesOf(scopeName) },
	// Every mutant in src/core is killed or disabled with its reason (100.00%
	// on 2026-09-30), so one new survivor or uncovered mutant fails the run.
	// A scope still being measured has break null: it reports and never fails.
	thresholds: { high: 90, low: 80, break: scope.breakThreshold },
	reporters: ["clear-text", "json"],
	// One report file per scope, so `bun run mutation:all` keeps every one.
	jsonReporter: { fileName: reportFileName(scopeName, process.env) },
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
