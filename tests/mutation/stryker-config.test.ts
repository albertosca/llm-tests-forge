import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const REPOSITORY = resolve(import.meta.dir, "../..");

const SCOPE_MODULE = join(REPOSITORY, "scripts/mutation/scopes.mjs");

/** The Stryker config as `bun run mutation <scope>` loads it: STRYKER_SCOPE set, and a module of its own per scope. */
async function configOf(scopeName: string): Promise<{
	mutate: string[];
	bun: { testFiles: string[] };
	thresholds: { break: number | null };
	jsonReporter: { fileName: string };
}> {
	const before = process.env.STRYKER_SCOPE;
	process.env.STRYKER_SCOPE = scopeName;
	try {
		return (
			await import(
				`${join(REPOSITORY, "stryker.config.mjs")}?scope=${scopeName}`
			)
		).default;
	} finally {
		if (before === undefined) delete process.env.STRYKER_SCOPE;
		else process.env.STRYKER_SCOPE = before;
	}
}

function testFilesUnder(directory: string): string[] {
	return [
		...new Bun.Glob("**/*.test.ts").scanSync({
			cwd: join(REPOSITORY, directory),
		}),
	].map((name) => `./${directory}/${name}`);
}

/** The tests that import code under src/<scope>/, found by reading each test's import lines. Tests under tests/live, tests/packages and tests/shims run under their own bunfig, never under Stryker. */
function importersOf(scopeName: string): string[] {
	const importPattern = new RegExp(`from "(?:\\.\\./)+src/${scopeName}/`);
	return [
		...new Bun.Glob("**/*.test.ts").scanSync({
			cwd: join(REPOSITORY, "tests"),
		}),
	]
		.filter((name) => !/^(live|packages|shims)\//.test(name))
		.filter((name) =>
			importPattern.test(readFileSync(join(REPOSITORY, "tests", name), "utf8")),
		)
		.map((name) => `./tests/${name}`)
		.sort();
}

/** What a scope's list leaves out: its own directories' tests, and (when it asks for them) every test importing its code. */
function missingFrom(
	scopeName: string,
	scope: { testDirectories: string[]; testsFromImporters: boolean },
	testFiles: string[],
): string[] {
	const wanted = [
		...scope.testDirectories.flatMap(testFilesUnder),
		...(scope.testsFromImporters ? importersOf(scopeName) : []),
	];
	return [...new Set(wanted)]
		.filter((file) => !testFiles.includes(file))
		.sort();
}

// Stryker's bun runner takes an explicit file list; a test left off it kills
// no mutants and raises no error.
describe("every mutation scope", async () => {
	const scopes = await import(SCOPE_MODULE);
	const scopeNames: string[] = scopes.SCOPE_NAMES;

	test("the scopes are core and one per other top-level directory of src that has code", () => {
		expect([...scopeNames].sort()).toEqual([
			"cli",
			"core",
			"emit",
			"llm",
			"report",
		]);
		expect(scopes.DEFAULT_SCOPE).toBe("core");
	});

	for (const scopeName of scopeNames)
		test(`${scopeName}: stryker lists every test file under its test directories, nested ones included, and every test that imports its code`, async () => {
			const config = await configOf(scopeName);
			const scope = scopes.SCOPES[scopeName];
			const onDisk = scope.testDirectories.flatMap(testFilesUnder);
			expect(onDisk.length).toBeGreaterThan(0);
			expect(missingFrom(scopeName, scope, config.bun.testFiles)).toEqual([]);
			// Nothing else: an extra is a test that exists, not a stale name.
			const known = new Set([
				...onDisk,
				...scope.extraTests.map((path: string) => `./${path}`),
			]);
			expect([...config.bun.testFiles].sort()).toEqual([...known].sort());
			for (const file of config.bun.testFiles)
				expect({ file, exists: existsSync(join(REPOSITORY, file)) }).toEqual({
					file,
					exists: true,
				});
			expect(config.mutate).toEqual(scope.mutate);
			expect(config.thresholds.break).toBe(scope.breakThreshold);
			expect(config.jsonReporter.fileName).toBe(
				`reports/mutation/mutation-${scopeName}.json`,
			);
		}, 30_000);

	test("a scope may fail its run only at 100, or not at all while its survivors are still being killed, and core never leaves 100", () => {
		for (const name of scopeNames)
			expect([100, null]).toContain(scopes.SCOPES[name].breakThreshold);
		expect(scopes.SCOPES.core.breakThreshold).toBe(100);
		// A scope whose survivors are all killed stays at 100: it never goes back to report-only.
		for (const name of ["core", "emit", "llm"])
			expect({
				name,
				breakThreshold: scopes.SCOPES[name].breakThreshold,
			}).toEqual({ name, breakThreshold: 100 });
	});

	// The checks above are only as good as the one that finds the gap.
	test("canary: a list missing one test of the scope's directory, or one test that imports its code, is reported", () => {
		const emit = scopes.SCOPES.emit;
		const complete = scopes.testFilesOf("emit");
		expect(missingFrom("emit", emit, complete)).toEqual([]);
		expect(
			missingFrom(
				"emit",
				emit,
				complete.filter((file: string) => file !== "./tests/emit/shim.test.ts"),
			),
		).toEqual(["./tests/emit/shim.test.ts"]);
		const llm = scopes.SCOPES.llm;
		expect(
			missingFrom(
				"llm",
				llm,
				scopes
					.testFilesOf("llm")
					.filter((file: string) => file !== "./tests/core/cases.test.ts"),
			),
		).toEqual(["./tests/core/cases.test.ts"]);
		expect(importersOf("llm")).toContain("./tests/core/cases.test.ts");
	});

	test("every source file with code is mutated by some scope; the one exception is named, with the reason in scopes.mjs", () => {
		const sourceFiles = [
			...new Bun.Glob("src/**/*.ts").scanSync({ cwd: REPOSITORY }),
		].filter((name) => !name.endsWith(".d.ts"));
		expect(sourceFiles.length).toBeGreaterThan(40);
		const mutated = (file: string) =>
			scopeNames.some((name) => {
				const patterns: string[] = scopes.SCOPES[name].mutate;
				const included = patterns
					.filter((pattern) => !pattern.startsWith("!"))
					.some((pattern) => new Bun.Glob(pattern).match(file));
				const excluded = patterns
					.filter((pattern) => pattern.startsWith("!"))
					.some((pattern) => new Bun.Glob(pattern.slice(1)).match(file));
				return included && !excluded;
			});
		expect(sourceFiles.filter((file) => !mutated(file))).toEqual([
			"src/cli/bin.ts",
		]);
	});

	test("a scope named in STRYKER_SCOPE is used, none means core, and an unknown one is an error that lists the scopes", () => {
		expect(scopes.scopeFromEnvironment({})).toBe("core");
		expect(scopes.scopeFromEnvironment({ STRYKER_SCOPE: "emit" })).toBe("emit");
		expect(() =>
			scopes.scopeFromEnvironment({ STRYKER_SCOPE: "nope" }),
		).toThrow(
			'Unknown mutation scope "nope": expected one of core, cli, emit, report, llm',
		);
		// Object.prototype's names are not scopes.
		expect(() =>
			scopes.scopeFromEnvironment({ STRYKER_SCOPE: "constructor" }),
		).toThrow("Unknown mutation scope");
	});

	test("the environment Stryker runs in names the scope and drops FORCE_COLOR, which would hide killed mutants as RuntimeErrors", () => {
		expect(
			scopes.mutationEnvironment("emit", {
				FORCE_COLOR: "3",
				PATH: "/bin",
				STRYKER_SCOPE: "core",
			}),
		).toStrictEqual({ PATH: "/bin", STRYKER_SCOPE: "emit" });
		expect(scopes.mutationEnvironment("llm", { HOME: "/h" })).toStrictEqual({
			HOME: "/h",
			STRYKER_SCOPE: "llm",
		});
	});

	test("`bun run mutation` refuses an unknown scope or two scopes with exit code 2 and the usage, before starting Stryker", () => {
		for (const argumentsList of [["nope"], ["core", "cli"], ["constructor"]]) {
			const child = Bun.spawnSync(
				[
					"node",
					join(REPOSITORY, "scripts/mutation/run.mjs"),
					...argumentsList,
				],
				{ cwd: REPOSITORY },
			);
			expect({ arguments: argumentsList, exitCode: child.exitCode }).toEqual({
				arguments: argumentsList,
				exitCode: 2,
			});
			expect(child.stderr.toString()).toContain(
				"Usage: bun run mutation [scope]\nScopes: core, cli, emit, report, llm (default core)",
			);
			expect(child.stdout.toString()).toBe("");
		}
	}, 30_000);
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
