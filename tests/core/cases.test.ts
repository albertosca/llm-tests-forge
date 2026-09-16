import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { toJSONSchema } from "zod";
import { casesOutputSchema, generateCases } from "../../src/core/cases";
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

describe("casesOutputSchema", () => {
	test("label oracle: accepts an input keyed by every feature input, refuses a missing one", async () => {
		const twoInputFeature: Feature = {
			...(await feature()),
			inputs: [
				{ name: "email", kind: "text" },
				{ name: "stage", kind: "text" },
			],
		};
		const schema = casesOutputSchema(twoInputFeature, scenario);
		expect(
			schema.safeParse({
				cases: [
					{
						input: { email: "x", stage: "y" },
						expected: { label: "rejection" },
					},
				],
			}).success,
		).toBe(true);
		const missingInput = schema.safeParse({
			cases: [{ input: {}, expected: { label: "x" } }],
		});
		expect(missingInput.success).toBe(false);
		expect(
			!missingInput.success &&
				missingInput.error.issues.some((issue) => issue.path.includes("email")),
		).toBe(true);
	});

	test("rubric oracle: refuses a label, accepts a rubric", async () => {
		const schema = casesOutputSchema(await feature(), {
			...scenario,
			oracle: "rubric",
		});
		expect(
			schema.safeParse({
				cases: [{ input: { email: "x" }, expected: { label: "x" } }],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				cases: [{ input: { email: "x" }, expected: { rubric: "s" } }],
			}).success,
		).toBe(true);
	});

	test("fields oracle: accepts a fields object, refuses an empty expected", async () => {
		const schema = casesOutputSchema(await feature(), {
			...scenario,
			oracle: "fields",
		});
		expect(
			schema.safeParse({
				cases: [
					{
						input: { email: "x" },
						expected: { fields: { company: "Acme" } },
					},
				],
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({ cases: [{ input: { email: "x" }, expected: {} }] })
				.success,
		).toBe(false);
	});

	test("the JSON Schema the model sees requires each feature input by name -- the property z.record left out", async () => {
		const schema = casesOutputSchema(await feature(), scenario);
		const jsonSchema = toJSONSchema(schema);
		const casesProp = jsonSchema.properties?.cases;
		if (!casesProp || typeof casesProp === "boolean")
			throw new Error("expected cases to be an object schema");
		const itemsProp = casesProp.items;
		if (
			!itemsProp ||
			typeof itemsProp === "boolean" ||
			Array.isArray(itemsProp)
		)
			throw new Error("expected cases.items to be an object schema");
		const inputProp = itemsProp.properties?.input;
		if (!inputProp || typeof inputProp === "boolean")
			throw new Error(
				"expected cases.items.properties.input to be an object schema",
			);
		expect(inputProp.properties?.email).toBeDefined();
		expect(inputProp.required).toContain("email");
	});
});

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

	test("a response with a key that doesn't match the feature's inputs fails the whole batch at the schema, naming the raw output", async () => {
		// With the strict per-call schema, `input` requires exactly the
		// feature's own input names -- a model returning `mail` instead of
		// `email` fails `generateObject`'s own validation before `cases.ts`
		// ever sees a candidate, so the whole batch fails with the raw output
		// saved under `.forge/failures/`, the same as any other schema-invalid
		// response. This replaces the old expectation that such a case was
		// merely dropped and its sibling kept.
		const { llm, model } = await llmFor("bad-keys");
		const err = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			"model output did not match the bad-keys schema",
		);
		expect((err as ForgeError).details.rawPath).toBeDefined();
	});

	test("throws a distinct message when the model returns no candidates at all, not '(0 dropped: )'", async () => {
		const { llm, model } = await llmFor("empty-cases");
		const err = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			"no usable case generated for scenario: the model returned no candidates",
		);
		expect((err as ForgeError).message).not.toContain("dropped");
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
		expect((err as ForgeError).details.id).toBe("polite-rejection");
	});

	test("throws when every generated case is invalid, even with reviewed cases already present", async () => {
		// `accepted.length === args.existing.length` and the naive
		// `accepted.length === 0` are indistinguishable when existing is empty
		// (the test above). This is the one shape that tells them apart: a
		// scenario that already has a reviewed case, whose fresh generation is
		// entirely garbage, must still throw rather than silently return the
		// old case and report success.
		const { llm, model } = await llmFor("all-bad");
		const existing: Case = {
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "already reviewed" },
			expected: { label: "rejection" },
			status: "approved",
			generated_by: "human",
		};
		const err = await generateCases({
			feature: await feature(),
			scenario,
			existing: [existing],
			n: 2,
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("2 dropped");
		expect((err as ForgeError).details.id).toBe("polite-rejection");
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
		// Identify, not just count: a regression that deduped against the wrong
		// candidate (dropping the new one, keeping the actual duplicate) would
		// still produce a length-2 array. Pin that the existing case survives
		// untouched and the SURVIVING new case is the non-duplicate input.
		expect(out[0]).toEqual(existing);
		expect(out[1]?.input).toEqual({
			email:
				"From: rh@brasiltech.com.br\nSubject: Retorno\n\nInfelizmente não avançaremos.",
		});
	});

	test("drops an exact duplicate that appears twice within the same model response", async () => {
		const { llm, model } = await llmFor("same-batch-dup");
		const out = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.input).toEqual({ email: "same" });
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

	test("refuses a scenario that is not approved, before calling the model", async () => {
		let calls = 0;
		// Mirrors tests/core/dedupe.test.ts's call-counting spy: `generate` is
		// generic in `Llm`, so the mock's returned object is cast to the
		// caller's own `T` rather than to `any`/`never` — this spy is never
		// called (that is what the test asserts), so the concrete shape of
		// `object` never matters. A regression that moved the status check to
		// after the model call would still satisfy a plain `.rejects.toThrow`;
		// only the call count proves a pending scenario costs nothing.
		const spy: Llm = {
			async generate<T>() {
				calls += 1;
				return {
					object: { cases: [] } as T,
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
		};
		const err = await generateCases({
			feature: await feature(),
			scenario: { ...scenario, status: "pending" },
			existing: [],
			n: 1,
			model: "anthropic/x",
			llm: spy,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).details.id).toBe("polite-rejection");
		expect(calls).toBe(0);
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
