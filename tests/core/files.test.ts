import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";
import {
	forgePaths,
	listCaseScenarios,
	readAllCases,
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
	const dir = await mkdtemp(join(tmpdir(), "forge-"));
	return join(dir, ".forge");
}

describe("forgePaths", () => {
	test("derives every path from the forge dir", () => {
		const p = forgePaths("/x/.forge");
		expect(p.feature).toBe("/x/.forge/feature.yaml");
		expect(p.scenarios).toBe("/x/.forge/scenarios.yaml");
		expect(p.casesDir).toBe("/x/.forge/cases");
		expect(p.suite).toBe("/x/.forge/suite.yaml");
		expect(p.usage).toBe("/x/.forge/usage.jsonl");
		expect(p.failuresDir).toBe("/x/.forge/failures");
	});
});

describe("feature round trip", () => {
	test("write then read returns the same object and creates the directory", async () => {
		const dir = await tmpForge();
		const fixture = await readFile(
			join(import.meta.dir, "../fixtures/feature.yaml"),
			"utf8",
		);
		const { parse } = await import("yaml");
		const feature = parse(fixture);
		await writeFeature(dir, feature);
		expect(await readFeature(dir)).toEqual(feature);
	});

	test("invalid file throws ForgeError naming the file", async () => {
		const dir = await tmpForge();
		await writeFeature(dir, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(dir).feature, "id: only-an-id\n");
		const err = await readFeature(dir).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("does not match schema");
		expect((err as ForgeError).message).toContain("feature.yaml");
	});

	test("missing file throws ForgeError naming the file", async () => {
		const dir = await tmpForge();
		const err = await readFeature(dir).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("file not found");
		expect((err as ForgeError).message).toContain("feature.yaml");
		expect((err as ForgeError).details.file).toBe(forgePaths(dir).feature);
	});

	test("malformed YAML syntax throws ForgeError naming the file", async () => {
		const dir = await tmpForge();
		await writeFeature(dir, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(dir).feature, "id: [unterminated\n");
		const err = await readFeature(dir).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("invalid YAML");
		expect((err as ForgeError).message).toContain("feature.yaml");
	});
});

describe("scenarios and cases", () => {
	test("missing files read as empty lists", async () => {
		const dir = await tmpForge();
		expect(await readScenarios(dir)).toEqual([]);
		expect(await readCases(dir, "nope")).toEqual([]);
		expect(await listCaseScenarios(dir)).toEqual([]);
	});

	test("round trip and listing sorted by scenario id", async () => {
		const dir = await tmpForge();
		const scenarios: Scenario[] = [
			{
				id: "b-scn",
				kind: "happy",
				oracle: "label",
				description: "b",
				status: "pending",
			},
		];
		await writeScenarios(dir, scenarios);
		expect(await readScenarios(dir)).toEqual(scenarios);
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
		await writeCases(dir, "b-scn", cases);
		await writeCases(
			dir,
			"a-scn",
			cases.map((c) => ({ ...c, id: "a-scn-01", scenario: "a-scn" })),
		);
		expect(await readCases(dir, "b-scn")).toEqual(cases);
		expect(await listCaseScenarios(dir)).toEqual(["a-scn", "b-scn"]);
	});
});

describe("forgePaths: plan 2 entries", () => {
	test("names the emitted config, the JSONL export and both report files under .forge", () => {
		const p = forgePaths("/x/.forge");
		expect(p.promptfooConfig).toBe("/x/.forge/promptfooconfig.yaml");
		expect(p.casesJsonl).toBe("/x/.forge/cases.jsonl");
		expect(p.reportMd).toBe("/x/.forge/report.md");
		expect(p.reportJson).toBe("/x/.forge/report.json");
	});
});

describe("suite.yaml", () => {
	const suite = {
		target: {
			kind: "promptfoo-python" as const,
			entry: "forge_target.py",
			models: ["anthropic/claude-haiku-4-5"],
		},
		judges: ["google/gemini-3.5-flash"],
		repeat: 2,
		include: [],
	};
	test("round-trips through writeSuite/readSuite", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "forge-files-")), ".forge");
		await writeSuite(dir, suite);
		expect(await readSuite(dir)).toEqual(suite);
	});
	test("readSuite on a missing file names the path and prints an example to copy", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "forge-files-")), ".forge");
		const err = await readSuite(dir).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain(join(dir, "suite.yaml"));
		expect((err as Error).message).toContain("target:");
		expect((err as Error).message).toContain("judges:");
	});
});

describe("readAllCases", () => {
	test("returns one entry per cases file, keyed by scenario id, in sorted order", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "forge-files-")), ".forge");
		const mk = (id: string, scenario: string) => ({
			id,
			scenario,
			input: { email: id },
			status: "approved" as const,
			generated_by: "t",
		});
		await writeCases(dir, "zeta", [mk("zeta-01", "zeta")]);
		await writeCases(dir, "alpha", [
			mk("alpha-01", "alpha"),
			mk("alpha-02", "alpha"),
		]);
		const all = await readAllCases(dir);
		expect([...all.keys()]).toEqual(["alpha", "zeta"]);
		expect(all.get("alpha")?.map((c) => c.id)).toEqual([
			"alpha-01",
			"alpha-02",
		]);
		expect(all.get("zeta")?.map((c) => c.id)).toEqual(["zeta-01"]);
	});
	test("is empty when there is no cases directory", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "forge-files-")), ".forge");
		expect((await readAllCases(dir)).size).toBe(0);
	});
});

describe("readYamlFile: array schema errors name the element, not just the path", () => {
	test("an issue on an array item with a string id reports the id and the index", async () => {
		const dir = await tmpForge();
		await mkdir(dir, { recursive: true });
		await writeFile(
			forgePaths(dir).scenarios,
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
		const err = await readScenarios(dir).catch((e: Error) => e);
		expect((err as Error).message).toContain(
			'item "third-id" (index 2).oracle:',
		);
		expect((err as Error).message).toContain(forgePaths(dir).scenarios);
	});
	test("an issue on an array item with no string id keeps the plain index.field form", async () => {
		const dir = await tmpForge();
		await mkdir(dir, { recursive: true });
		await writeFile(
			forgePaths(dir).scenarios,
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
		const err = await readScenarios(dir).catch((e: Error) => e);
		expect((err as Error).message).toContain("2.oracle: Invalid option");
		expect((err as Error).message).not.toContain('item "');
		expect((err as Error).message).toContain(forgePaths(dir).scenarios);
	});
	test("a schema error on a non-array file keeps the plain 'field: message' form", async () => {
		const dir = await tmpForge();
		await writeFeature(dir, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(dir).feature, "id: only-an-id\n");
		const err = await readFeature(dir).catch((e: Error) => e);
		expect((err as Error).message).toContain("purpose: Invalid input");
	});
});

describe("readYamlFile: the real cause of a read failure", () => {
	test("a directory where a file was expected says so, not 'file not found'", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-files-"));
		const target = join(dir, "suite.yaml");
		await mkdir(target);
		const err = await readYamlFile(target, SuiteSchema).catch((e: Error) => e);
		expect((err as Error).message).toContain("is a directory");
		expect((err as Error).message).not.toContain("not found");
	});
	// Skipped as root (e.g. some CI/container setups): root ignores the
	// 0o000 permission bits and the read succeeds instead of failing with
	// EACCES, which would make this assertion meaningless there.
	test.skipIf(process.getuid?.() === 0)(
		"an unreadable file says 'permission denied'",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "forge-files-"));
			const target = join(dir, "suite.yaml");
			await writeFile(target, "target: {}");
			await chmod(target, 0o000);
			const err = await readYamlFile(target, SuiteSchema).catch(
				(e: Error) => e,
			);
			await chmod(target, 0o600);
			expect((err as Error).message).toContain("permission denied");
		},
	);
	test("a missing file still says 'file not found'", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-files-"));
		const err = await readYamlFile(join(dir, "nope.yaml"), SuiteSchema).catch(
			(e: Error) => e,
		);
		expect((err as Error).message).toContain("file not found");
	});
	test("an error with no code at all (not from fs) falls through to 'cannot read: <message>'", () => {
		expect(readFailure(new Error("boom"))).toBe("cannot read: boom");
	});
	test("an OS error with no special-cased code (ENOTDIR) falls through to 'cannot read: <message>'", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-files-"));
		const notADir = join(dir, "afile");
		await writeFile(notADir, "hi");
		const target = join(notADir, "child.yaml");
		const rawErr = await readFile(target, "utf8").catch((e: Error) => e);
		const err = await readYamlFile(target, SuiteSchema).catch((e: Error) => e);
		expect((rawErr as NodeJS.ErrnoException).code).toBe("ENOTDIR");
		expect((err as Error).message).toBe(
			`cannot read: ${(rawErr as Error).message} (file: ${target})`,
		);
	});
});
