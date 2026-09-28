import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";
import {
	caseFileFingerprint,
	forgePaths,
	listCaseScenarios,
	readAllCases,
	readCaseFile,
	readCases,
	readFailure,
	readFeature,
	readScenarios,
	readSuite,
	readYamlFile,
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
} from "../../src/core/files";
import type { Case, Scenario } from "../../src/core/schemas";
import { SuiteSchema } from "../../src/core/schemas";

async function tmpForge(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-"));
	return join(directory, ".forge");
}

describe("forgePaths", () => {
	test("derives every path from the forge dir", () => {
		const paths = forgePaths("/x/.forge");
		expect(paths.feature).toBe("/x/.forge/feature.yaml");
		expect(paths.scenarios).toBe("/x/.forge/scenarios.yaml");
		expect(paths.casesDir).toBe("/x/.forge/cases");
		expect(paths.suite).toBe("/x/.forge/suite.yaml");
		expect(paths.usage).toBe("/x/.forge/usage.jsonl");
		expect(paths.failuresDir).toBe("/x/.forge/failures");
	});
});

describe("feature round trip", () => {
	test("write then read returns the same object and creates the directory", async () => {
		const directory = await tmpForge();
		const fixture = await readFile(
			join(import.meta.dir, "../fixtures/feature.yaml"),
			"utf8",
		);
		const { parse } = await import("yaml");
		const feature = parse(fixture);
		await writeFeature(directory, feature);
		expect(await readFeature(directory)).toEqual(feature);
	});

	test("invalid file throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: only-an-id\n");
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("does not match schema");
		expect((caught as ForgeError).message).toContain("feature.yaml");
	});

	test("missing file throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("file not found");
		expect((caught as ForgeError).message).toContain("feature.yaml");
		expect((caught as ForgeError).details.file).toBe(
			forgePaths(directory).feature,
		);
	});

	test("malformed YAML syntax throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: [unterminated\n");
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("invalid YAML");
		expect((caught as ForgeError).message).toContain("feature.yaml");
	});
});

describe("scenarios and cases", () => {
	test("missing files read as empty lists", async () => {
		const directory = await tmpForge();
		expect(await readScenarios(directory)).toEqual([]);
		expect(await readCases(directory, "nope")).toEqual([]);
		expect(await listCaseScenarios(directory)).toEqual([]);
	});

	test("round trip and listing sorted by scenario id", async () => {
		const directory = await tmpForge();
		const scenarios: Scenario[] = [
			{
				id: "b-scn",
				kind: "happy",
				oracle: "label",
				description: "b",
				status: "pending",
			},
		];
		await writeScenarios(directory, scenarios);
		expect(await readScenarios(directory)).toEqual(scenarios);
		const cases: Case[] = [
			{
				id: "b-scn-01",
				scenario: "b-scn",
				input: { email: "hi" },
				expected: { label: "x" },
				status: "pending",
				generated_by: "t",
			},
		];
		await writeCases(directory, "b-scn", cases);
		await writeCases(
			directory,
			"a-scn",
			cases.map((caseEntry) => ({
				...caseEntry,
				id: "a-scn-01",
				scenario: "a-scn",
			})),
		);
		expect(await readCases(directory, "b-scn")).toEqual(cases);
		expect(await listCaseScenarios(directory)).toEqual(["a-scn", "b-scn"]);
	});
});

describe("readCaseFile", () => {
	test("a cases file that does not exist reads as null, not as an empty list with no fingerprint", async () => {
		const forgeDirectory = await tmpForge();
		expect(await readCaseFile(forgeDirectory, "absent")).toBeNull();
	});
	test("an existing cases file reads as its cases together with the fingerprint of that file", async () => {
		const forgeDirectory = await tmpForge();
		const cases: Case[] = [
			{
				id: "present-01",
				scenario: "present",
				input: { email: "hi" },
				expected: { label: "x" },
				status: "pending",
				generated_by: "hand",
			},
		];
		await writeCases(forgeDirectory, "present", cases);
		const fingerprint = await caseFileFingerprint(forgeDirectory, "present");
		if (fingerprint === null) throw new Error("the file was just written");
		expect(await readCaseFile(forgeDirectory, "present")).toEqual({
			cases,
			fingerprint,
		});
	});
});

describe("forgePaths: plan 2 entries", () => {
	test("names the emitted config, the JSONL export and both report files under .forge", () => {
		const paths = forgePaths("/x/.forge");
		expect(paths.promptfooConfig).toBe("/x/.forge/promptfooconfig.yaml");
		expect(paths.casesJsonl).toBe("/x/.forge/cases.jsonl");
		expect(paths.reportMd).toBe("/x/.forge/report.md");
		expect(paths.reportJson).toBe("/x/.forge/report.json");
	});
});

describe("suite.yaml", () => {
	const suite = {
		target: {
			kind: "python" as const,
			entry: "forge_target.py",
			models: ["anthropic/claude-haiku-4-5"],
		},
		judges: ["google/gemini-3.5-flash"],
		repeat: 2,
		include: [],
	};
	test("round-trips through writeSuite/readSuite", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		await writeSuite(directory, suite);
		expect(await readSuite(directory)).toEqual(suite);
	});
	test("readSuite on a missing file names the path and prints an example to copy", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		const caught = await readSuite(directory).catch((error: Error) => error);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as Error).message).toContain(join(directory, "suite.yaml"));
		expect((caught as Error).message).toContain("target:");
		expect((caught as Error).message).toContain("judges:");
	});
});

describe("readAllCases", () => {
	test("returns one entry per cases file, keyed by scenario id, in sorted order", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		const makeCase = (id: string, scenario: string) => ({
			id,
			scenario,
			input: { email: id },
			status: "approved" as const,
			generated_by: "t",
		});
		await writeCases(directory, "zeta", [makeCase("zeta-01", "zeta")]);
		await writeCases(directory, "alpha", [
			makeCase("alpha-01", "alpha"),
			makeCase("alpha-02", "alpha"),
		]);
		const all = await readAllCases(directory);
		expect([...all.keys()]).toEqual(["alpha", "zeta"]);
		expect(all.get("alpha")?.map((caseEntry) => caseEntry.id)).toEqual([
			"alpha-01",
			"alpha-02",
		]);
		expect(all.get("zeta")?.map((caseEntry) => caseEntry.id)).toEqual([
			"zeta-01",
		]);
	});
	test("is empty when there is no cases directory", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		expect((await readAllCases(directory)).size).toBe(0);
	});
});

describe("readYamlFile: array schema errors name the element, not just the path", () => {
	test("an issue on an array item with a string id reports the id and the index", async () => {
		const directory = await tmpForge();
		await mkdir(directory, { recursive: true });
		await writeFile(
			forgePaths(directory).scenarios,
			`- id: first-id
  kind: happy
  oracle: label
  description: a
  status: pending
- id: second-id
  kind: happy
  oracle: label
  description: b
  status: pending
- id: third-id
  kind: happy
  oracle: bogus
  description: c
  status: pending
`,
		);
		const caught = await readScenarios(directory).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain(
			'item "third-id" (index 2).oracle:',
		);
		expect((caught as Error).message).toContain(
			forgePaths(directory).scenarios,
		);
	});
	test("an issue on an array item with no string id keeps the plain index.field form", async () => {
		const directory = await tmpForge();
		await mkdir(directory, { recursive: true });
		await writeFile(
			forgePaths(directory).scenarios,
			`- id: first-id
  kind: happy
  oracle: label
  description: a
  status: pending
- id: second-id
  kind: happy
  oracle: label
  description: b
  status: pending
- kind: happy
  oracle: bogus
  description: c
  status: pending
`,
		);
		const caught = await readScenarios(directory).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain("2.oracle: Invalid option");
		expect((caught as Error).message).not.toContain('item "');
		expect((caught as Error).message).toContain(
			forgePaths(directory).scenarios,
		);
	});
	test("a schema error on a non-array file keeps the plain 'field: message' form", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: only-an-id\n");
		const caught = await readFeature(directory).catch((error: Error) => error);
		expect((caught as Error).message).toContain("purpose: Invalid input");
	});
});

describe("readYamlFile: the real cause of a read failure", () => {
	test("a directory where a file was expected says so, not 'file not found'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const target = join(directory, "suite.yaml");
		await mkdir(target);
		const caught = await readYamlFile(target, SuiteSchema).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain("is a directory");
		expect((caught as Error).message).not.toContain("not found");
	});
	// Skipped as root (e.g. some CI/container setups): root ignores the
	// 0o000 permission bits and the read succeeds instead of failing with
	// EACCES, which would make this assertion meaningless there.
	test.skipIf(process.getuid?.() === 0)(
		"an unreadable file says 'permission denied'",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
			const target = join(directory, "suite.yaml");
			await writeFile(target, "target: {}");
			await chmod(target, 0o000);
			const caught = await readYamlFile(target, SuiteSchema).catch(
				(error: Error) => error,
			);
			await chmod(target, 0o600);
			expect((caught as Error).message).toContain("permission denied");
		},
	);
	test("a missing file still says 'file not found'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const caught = await readYamlFile(
			join(directory, "nope.yaml"),
			SuiteSchema,
		).catch((error: Error) => error);
		expect((caught as Error).message).toContain("file not found");
	});
	test("an error with no code at all (not from fs) falls through to 'cannot read: <message>'", () => {
		expect(readFailure(new Error("boom"))).toBe("cannot read: boom");
	});
	test("an OS error with no special-cased code (ENOTDIR) falls through to 'cannot read: <message>'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const fileNotDirectory = join(directory, "afile");
		await writeFile(fileNotDirectory, "hi");
		const target = join(fileNotDirectory, "child.yaml");
		const rawError = await readFile(target, "utf8").catch(
			(error: Error) => error,
		);
		const caught = await readYamlFile(target, SuiteSchema).catch(
			(error: Error) => error,
		);
		expect((rawError as NodeJS.ErrnoException).code).toBe("ENOTDIR");
		expect((caught as Error).message).toBe(
			`cannot read: ${(rawError as Error).message} (file: ${target})`,
		);
	});
});
