import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";
import {
	forgePaths,
	listCaseScenarios,
	readCases,
	readFeature,
	readScenarios,
	writeCases,
	writeFeature,
	writeScenarios,
} from "../../src/core/files";
import type { Case, Scenario } from "../../src/core/schemas";

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
