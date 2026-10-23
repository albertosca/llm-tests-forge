import { existsSync, readdirSync } from "node:fs";
import path, { basename } from "node:path";
import { fileURLToPath } from "node:url";

// One mutation scope per top-level directory of src. A scope is a separate
// Stryker run (and a separate CI job), so each fits the job's time limit and
// a scope that still has survivors cannot fail the others.
//
// - mutate: the files whose mutants the scope counts.
// - testDirectories: every test file under these directories (found on disk,
//   recursively, so a new test joins on its own) runs against the scope.
// - extraTests: test files elsewhere that import the scope's code. A test
//   that imports src/<scope> and is left off kills mutants it could have
//   killed, and nothing says so; tests/mutation/stryker-config.test.ts reads
//   the imports of every test and fails for a scope with
//   `testsFromImporters` when one is missing. src/core is the exception: its
//   100.00 was earned with tests/core alone, and nearly every other test
//   imports core, so listing importers would only slow its run.
// - breakThreshold: the score below which the run fails. 100 for a scope with
//   no survivor; null (report only) for a scope still being measured, so the
//   main branch never goes red while survivors exist. A scope's survivors are
//   killed, and its break set to 100, in a later change.
export const SCOPES = {
	core: {
		mutate: ["src/core/**/*.ts"],
		testDirectories: ["tests/core"],
		extraTests: [],
		testsFromImporters: false,
		breakThreshold: 100,
	},
	cli: {
		// bin.ts runs `process.exit(await main(...))` the moment it is imported,
		// and the bun runner imports every mutated file eagerly, so mutating it
		// kills the test process before the first test (the dry run fails with
		// exit code 2). bunfig.toml leaves it out of coverage for the same
		// reason; the compiled-binary test is what runs it.
		mutate: ["src/cli/**/*.ts", "!src/cli/bin.ts"],
		testDirectories: ["tests/cli"],
		extraTests: [],
		testsFromImporters: true,
		breakThreshold: 100,
	},
	emit: {
		mutate: ["src/emit/**/*.ts"],
		testDirectories: ["tests/emit"],
		extraTests: [],
		testsFromImporters: true,
		breakThreshold: 100,
	},
	report: {
		mutate: ["src/report/**/*.ts"],
		testDirectories: ["tests/report"],
		extraTests: ["tests/core/estimate.test.ts", "tests/core/report.test.ts"],
		testsFromImporters: true,
		breakThreshold: 100,
	},
	llm: {
		mutate: ["src/llm/**/*.ts"],
		testDirectories: ["tests/llm"],
		extraTests: [
			"tests/core/cases.test.ts",
			"tests/core/dedupe.test.ts",
			"tests/core/describe.test.ts",
			"tests/core/scenarios.test.ts",
		],
		testsFromImporters: true,
		breakThreshold: 100,
	},
};

export const DEFAULT_SCOPE = "core";

export const SCOPE_NAMES = Object.keys(SCOPES);

/**
 * The scope's test files as `bun test` wants them: the bun runner passes
 * testFiles verbatim, with no glob expansion, and a bare name is a filter, so
 * each is a ./path. The root is found from this file, so the list is the
 * same whatever directory imports it.
 */
export function testFilesOf(scopeName) {
	const scope = SCOPES[scopeName];
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const found = scope.testDirectories.flatMap((directory) =>
		readdirSync(`${root}${directory}`, { recursive: true })
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => `./${directory}/${name}`),
	);
	return [...found, ...scope.extraTests.map((path) => `./${path}`)].sort();
}

/** The scope named in STRYKER_SCOPE, or core; an unknown name is an error, never a silent default. */
export function scopeFromEnvironment(environment) {
	const name = environment.STRYKER_SCOPE ?? DEFAULT_SCOPE;
	if (!Object.hasOwn(SCOPES, name))
		throw new Error(
			`Unknown mutation scope "${name}": expected one of ${SCOPE_NAMES.join(", ")}`,
		);
	return name;
}

/**
 * What `bun run mutation` was asked: `[scope]`, or `[scope, "--mutate",
 * file]` to run the scope's whole test list against one file of it (an
 * iteration loop: minutes instead of the whole scope's twenty). Anything else
 * is null, and the caller prints the usage.
 */
export function parseMutationArguments(argumentsList) {
	const [first = DEFAULT_SCOPE, flag, file, ...rest] = argumentsList;
	if (!Object.hasOwn(SCOPES, first)) return null;
	if (argumentsList.length <= 1) return { scopeName: first, mutateFile: null };
	if (flag !== "--mutate" || file === undefined || rest.length > 0) return null;
	return { scopeName: first, mutateFile: file };
}

/**
 * The files the scope mutates, or the one file named in STRYKER_MUTATE_FILE.
 * That file must be one the scope would mutate anyway and must exist: a typo
 * would otherwise run Stryker over nothing and report a clean score.
 */
export function mutateFromEnvironment(scopeName, environment) {
	const file = environment.STRYKER_MUTATE_FILE;
	const scope = SCOPES[scopeName];
	if (file === undefined || file === "") return scope.mutate;
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const included = scope.mutate
		.filter((pattern) => !pattern.startsWith("!"))
		.some((pattern) => path.matchesGlob(file, pattern));
	const excluded = scope.mutate
		.filter((pattern) => pattern.startsWith("!"))
		.some((pattern) => path.matchesGlob(file, pattern.slice(1)));
	if (!included || excluded || !existsSync(`${root}${file}`))
		throw new Error(
			`"${file}" is not a file the ${scopeName} scope mutates (expected an existing file matching ${scope.mutate.join(", ")})`,
		);
	return [file];
}

/** One report file per scope, and one per file of a one-file run, so that run never overwrites the scope's own. */
export function reportFileName(scopeName, environment) {
	const file = environment.STRYKER_MUTATE_FILE;
	const suffix =
		file === undefined || file === "" ? "" : `-${basename(file, ".ts")}`;
	return `reports/mutation/mutation-${scopeName}${suffix}.json`;
}

/**
 * The environment Stryker and the test runs it spawns get. FORCE_COLOR is
 * dropped: it makes `bun test` colour its output even through a pipe, and
 * the bun runner reads that output with patterns that expect plain text
 * (`✗ name`). Coloured, it finds no test in a failing run, so a mutant that
 * made tests fail is reported as a RuntimeError, outside the score, instead
 * of Killed. Measured on the emit scope: 39 RuntimeError mutants with
 * FORCE_COLOR=3, none without it.
 */
export function mutationEnvironment(scopeName, environment, mutateFile = null) {
	const {
		FORCE_COLOR: _forcedColor,
		STRYKER_MUTATE_FILE: _staleFile,
		...rest
	} = environment;
	return {
		...rest,
		STRYKER_SCOPE: scopeName,
		...(mutateFile === null ? {} : { STRYKER_MUTATE_FILE: mutateFile }),
	};
}
