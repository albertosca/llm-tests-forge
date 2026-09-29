import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
	findProjectRoot,
	projectFileText,
	readProject,
	registeredSuiteNames,
	registerSuite,
} from "../../src/core/project";
import { projectWith } from "../helpers/project";

describe("forge.yaml", () => {
	test("findProjectRoot walks up to the nearest forge.yaml and returns null at the filesystem root", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-project-"));
		await writeFile(join(root, "forge.yaml"), projectFileText("python"));
		await mkdir(join(root, "evals", "a", "deep"), { recursive: true });
		expect(await findProjectRoot(join(root, "evals", "a", "deep"))).toBe(root);
		const outside = await mkdtemp(join(tmpdir(), "forge-noproject-"));
		expect(await findProjectRoot(outside)).toBeNull();
	});
	test("readProject keeps the good suites and reports each bad entry by name, without throwing", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites:\n  - evals/a\n  - evals/a/\n  - ../outside\n  - /abs/path\n  - evals\\win\n  - evals/b\n",
		);
		const project = await readProject(root);
		expect(project.suites.map((suite) => suite.entry)).toEqual([
			"evals/a",
			"evals/b",
		]);
		expect(project.suites[0]?.directory).toBe(join(root, "evals", "a"));
		expect(project.problems).toEqual([
			{ entry: "evals/a/", reason: 'suite "evals/a/" is listed twice' },
			{
				entry: "../outside",
				reason: 'suite "../outside" climbs out of the project',
			},
			{
				entry: "/abs/path",
				reason:
					'suite "/abs/path" is an absolute path; list it relative to forge.yaml',
			},
			{
				entry: "evals\\win",
				reason:
					'suite "evals\\win" uses a backslash; write paths with forward slashes',
			},
		]);
	});
	test("a forge.yaml that does not parse or match the schema throws, naming the file", async () => {
		const root = await projectWith("version: 2\nlanguage: python\n");
		await expect(readProject(root)).rejects.toThrow(join(root, "forge.yaml"));
	});
	test("registerSuite appends one entry with forward slashes and keeps every comment; an entry already there returns null", async () => {
		const text =
			"# the project file\nversion: 1\nlanguage: python # main language\nsuites:\n  - evals/a # first\n";
		const root = await projectWith(text);
		const project = await readProject(root);
		const registered = registerSuite(project, join(root, "evals", "b"));
		expect(registered?.entry).toBe("evals/b");
		expect(registered?.text).toBe(
			"# the project file\nversion: 1\nlanguage: python # main language\nsuites:\n  - evals/a # first\n  - evals/b\n",
		);
		expect(registerSuite(project, join(root, "evals", "a"))).toBeNull();
	});
	test("registerSuite on a file with no suites key, or with suites: [], adds the list", async () => {
		const bare = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		expect(registerSuite(bare, join(bare.root, "x"))?.text).toContain(
			"suites:\n  - x\n",
		);
		const empty = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: []\n"),
		);
		expect(
			parse(registerSuite(empty, join(empty.root, "x"))?.text ?? "").suites,
		).toEqual(["x"]);
	});
	test("registerSuite treats ./evals/a/ and evals/a/ as the already-registered evals/a", async () => {
		for (const written of ["./evals/a/", "evals/a/"]) {
			const project = await readProject(
				await projectWith(
					`version: 1\nlanguage: go\nsuites:\n  - ${written}\n`,
				),
			);
			expect(
				registerSuite(project, join(project.root, "evals", "a")),
			).toBeNull();
		}
	});
	test("registerSuite refuses a directory outside the project, naming forge.yaml", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		const outside = join(project.root, "..", "elsewhere");
		expect(() => registerSuite(project, outside)).toThrow(
			`${outside} is outside the project at ${project.root}; a suite must live inside it`,
		);
		expect(() => registerSuite(project, outside)).toThrow(project.file);
	});
	test("a bare suites: (with or without a comment) reads as an empty list and registerSuite then adds the list", async () => {
		for (const line of ["suites:", "suites: # c"]) {
			const project = await readProject(
				await projectWith(`version: 1\nlanguage: go\n${line}\n`),
			);
			expect(project.suites).toEqual([]);
			const text = registerSuite(project, join(project.root, "x"))?.text ?? "";
			expect(parse(text).suites).toEqual(["x"]);
		}
	});
	test("registerSuite keeps the trailing comment on suites: [] # keep", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: [] # keep\n"),
		);
		const text = registerSuite(project, join(project.root, "x"))?.text ?? "";
		expect(text).toContain("# keep");
		expect(parse(text).suites).toEqual(["x"]);
	});
	test("registeredSuiteNames lists the entries, or says none yet", async () => {
		expect(
			registeredSuiteNames(
				await readProject(await projectWith("version: 1\nlanguage: go\n")),
			),
		).toBe("none yet");
		expect(
			registeredSuiteNames(
				await readProject(
					await projectWith(
						"version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/b\n",
					),
				),
			),
		).toBe("evals/a, evals/b");
	});
	test("projectFileText reads back as the language with no suites and empty defaults", async () => {
		const root = await projectWith(projectFileText("elixir"));
		const project = await readProject(root);
		expect(project.config).toEqual({
			version: 1,
			language: "elixir",
			suites: [],
			defaults: {},
		});
	});
	test("uncommenting any one default in projectFileText, or all of them, still reads", async () => {
		const text = projectFileText("python");
		const expected: Record<string, unknown> = {
			drafter: "google/gemini-3.5-flash",
			target_models: ["anthropic/claude-haiku-4-5"],
			judges: ["google/gemini-3.5-flash"],
		};
		for (const [name, value] of Object.entries(expected)) {
			expect(text).toContain(`\n  # ${name}: `);
			const uncommented = text.replace(`  # ${name}: `, `  ${name}: `);
			const project = await readProject(await projectWith(uncommented));
			expect(project.config.defaults).toEqual({ [name]: value });
		}
		const all = text.replaceAll("  # ", "  ");
		expect((await readProject(await projectWith(all))).config.defaults).toEqual(
			expected,
		);
	});
});
