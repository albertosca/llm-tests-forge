import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expectedMatchesOracle, generateCases } from "../../src/core/cases";
import { ForgeError } from "../../src/core/errors";
import type { Case, Feature, Scenario } from "../../src/core/schemas";
import { createLlm, type GenerateArgs, type Llm } from "../../src/llm/generate";

const FIXTURE = "tests/fixtures/cases-response.json";
const scenario: Scenario = {
	id: "polite-rejection",
	kind: "happy",
	oracle: "label",
	description: "a polite no",
	status: "approved",
};

async function llmFor(verb: string): Promise<{ llm: Llm; model: string }> {
	const base = createLlm({
		forgeDir: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
	const llm: Llm = {
		generate: <T>(args: GenerateArgs<T>) => base.generate<T>({ ...args, verb }),
	};
	return { model: `fake/${FIXTURE}`, llm };
}
async function feature(): Promise<Feature> {
	return parse(
		await readFile(join(import.meta.dir, "../fixtures/feature.yaml"), "utf8"),
	);
}

describe("generateCases", () => {
	test("appends pending cases with sequential ids and generated_by", async () => {
		const { llm, model } = await llmFor("cases");
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		});
		expect(out.map((c) => c.id)).toEqual([
			"polite-rejection-01",
			"polite-rejection-02",
		]);
		expect(out[0]?.status).toBe("pending");
		expect(out[0]?.generated_by).toBe(model);
		expect(out[1]?.expected).toEqual({ label: "rejection" });
	});

	test("never overwrites reviewed cases and continues numbering", async () => {
		const { llm, model } = await llmFor("cases");
		const kept: Case = {
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "old" },
			expected: { label: "rejection" },
			status: "approved",
			generated_by: "human",
		};
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [kept],
			n: 2,
			model,
			llm,
		});
		expect(out[0]).toEqual(kept);
		expect(out.slice(1).map((c) => c.id)).toEqual([
			"polite-rejection-02",
			"polite-rejection-03",
		]);
	});

	test("drops a case whose label is outside the feature's labels, keeps the rest", async () => {
		const { llm, model } = await llmFor("bad-label");
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.expected).toEqual({ label: "rejection" });
	});

	test("drops a case whose input keys don't match the feature's inputs, keeps the rest", async () => {
		const { llm, model } = await llmFor("bad-keys");
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.input).toEqual({ email: "y" });
	});

	test("throws when every generated case is invalid", async () => {
		const { llm, model } = await llmFor("all-bad");
		const err = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("2 dropped");
	});

	test("drops exact duplicates of existing inputs", async () => {
		const { llm, model } = await llmFor("cases");
		const existing: Case = {
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: {
				email:
					"From: hr@globex.com\nSubject: Update\n\nWe decided to move forward with other candidates.",
			},
			expected: { label: "rejection" },
			status: "pending",
			generated_by: "t",
		};
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [existing],
			n: 2,
			model,
			llm,
		});
		expect(out).toHaveLength(2);
	});

	test("rubric oracle requires a rubric", async () => {
		const { llm, model } = await llmFor("rubric");
		const out = await generateCases({
			feature: await feature(),
			scenario: { ...scenario, oracle: "rubric" },
			existing: [],
			n: 1,
			model,
			llm,
		});
		expect(out[0]?.expected).toEqual({
			rubric: "summary mentions the optional quiz",
		});
	});

	test("refuses a scenario that is not approved", async () => {
		const { llm, model } = await llmFor("cases");
		await expect(
			generateCases({
				feature: await feature(),
				scenario: { ...scenario, status: "pending" },
				existing: [],
				n: 1,
				model,
				llm,
			}),
		).rejects.toThrow(ForgeError);
	});

	test("fields oracle requires an expected.fields object", async () => {
		const { llm, model } = await llmFor("fields");
		const out = await generateCases({
			feature: await feature(),
			scenario: { ...scenario, oracle: "fields" },
			existing: [],
			n: 1,
			model,
			llm,
		});
		expect(out[0]?.expected).toEqual({ fields: { type: "rejection" } });
	});
});

describe("expectedMatchesOracle", () => {
	test("label: null when the label is one of the feature's labels", async () => {
		expect(
			expectedMatchesOracle({ label: "rejection" }, scenario, await feature()),
		).toBeNull();
	});

	test("label: reports a missing expected.label", async () => {
		const msg = expectedMatchesOracle(
			{ fields: { type: "rejection" } },
			scenario,
			await feature(),
		);
		expect(msg).toBe("oracle is label but expected.label is missing");
	});

	test("label: reports a label outside the feature's labels", async () => {
		const msg = expectedMatchesOracle(
			{ label: "maybe" },
			scenario,
			await feature(),
		);
		expect(msg).toBe(`label "maybe" is not one of the feature's labels`);
	});

	test("fields: null when expected.fields is present", async () => {
		const fieldsScenario: Scenario = { ...scenario, oracle: "fields" };
		expect(
			expectedMatchesOracle(
				{ fields: { type: "rejection" } },
				fieldsScenario,
				await feature(),
			),
		).toBeNull();
	});

	test("fields: reports a missing expected.fields", async () => {
		const fieldsScenario: Scenario = { ...scenario, oracle: "fields" };
		const msg = expectedMatchesOracle(
			{ label: "rejection" },
			fieldsScenario,
			await feature(),
		);
		expect(msg).toBe("oracle is fields but expected.fields is missing");
	});

	test("rubric: null when expected.rubric is present", async () => {
		const rubricScenario: Scenario = { ...scenario, oracle: "rubric" };
		expect(
			expectedMatchesOracle(
				{ rubric: "checks something" },
				rubricScenario,
				await feature(),
			),
		).toBeNull();
	});

	test("rubric: reports a missing expected.rubric", async () => {
		const rubricScenario: Scenario = { ...scenario, oracle: "rubric" };
		const msg = expectedMatchesOracle(
			{ label: "rejection" },
			rubricScenario,
			await feature(),
		);
		expect(msg).toBe("oracle is rubric but expected.rubric is missing");
	});
});
