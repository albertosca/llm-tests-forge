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
		forgeDirectory: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
	const llm: Llm = {
		generate: <T>(request: GenerateArgs<T>) =>
			base.generate<T>({ ...request, verb }),
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
						expected: { fields: '{"company":"Acme"}' },
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
		const casesProperty = jsonSchema.properties?.cases;
		if (!casesProperty || typeof casesProperty === "boolean")
			throw new Error("expected cases to be an object schema");
		const itemsProperty = casesProperty.items;
		if (
			!itemsProperty ||
			typeof itemsProperty === "boolean" ||
			Array.isArray(itemsProperty)
		)
			throw new Error("expected cases.items to be an object schema");
		const inputProperty = itemsProperty.properties?.input;
		if (!inputProperty || typeof inputProperty === "boolean")
			throw new Error(
				"expected cases.items.properties.input to be an object schema",
			);
		expect(inputProperty.properties?.email).toBeDefined();
		expect(inputProperty.required).toContain("email");
	});

	test("the JSON Schema the model sees asks for expected.fields as JSON text -- an object schema came back {} or was refused", async () => {
		const jsonFeature = {
			...(await feature()),
			output: { kind: "json" as const, fields: ["questions"] },
		};
		const schema = casesOutputSchema(jsonFeature, {
			...scenario,
			oracle: "fields",
		});
		const jsonSchema = toJSONSchema(schema);
		const casesProperty = jsonSchema.properties?.cases;
		if (!casesProperty || typeof casesProperty === "boolean")
			throw new Error("expected cases to be an object schema");
		const itemsProperty = casesProperty.items;
		if (
			!itemsProperty ||
			typeof itemsProperty === "boolean" ||
			Array.isArray(itemsProperty)
		)
			throw new Error("expected cases.items to be an object schema");
		const expectedProperty = itemsProperty.properties?.expected;
		if (!expectedProperty || typeof expectedProperty === "boolean")
			throw new Error(
				"expected cases.items.properties.expected to be an object schema",
			);
		const fieldsProperty = expectedProperty.properties?.fields;
		if (!fieldsProperty || typeof fieldsProperty === "boolean")
			throw new Error("expected expected.properties.fields to be a schema");
		expect(fieldsProperty.type).toBe("string");
		expect(fieldsProperty.description).toContain(
			"JSON object serialised as a string",
		);
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
		expect(out.map((generated) => generated.id)).toEqual([
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
		expect(out.slice(1).map((generated) => generated.id)).toEqual([
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
		const failure = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			"model output did not match the bad-keys schema",
		);
		expect((failure as ForgeError).details.rawPath).toBeDefined();
	});

	test("throws a distinct message when the model returns no candidates at all, not '(0 dropped: )'", async () => {
		const { llm, model } = await llmFor("empty-cases");
		const failure = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			"no usable case generated for scenario: the model returned no candidates",
		);
		expect((failure as ForgeError).message).not.toContain("dropped");
	});

	test("throws when every generated case is invalid", async () => {
		const { llm, model } = await llmFor("all-bad");
		const failure = await generateCases({
			feature: await feature(),
			scenario,
			existing: [],
			n: 2,
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("2 dropped");
		expect((failure as ForgeError).details.id).toBe("polite-rejection");
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
		const failure = await generateCases({
			feature: await feature(),
			scenario,
			existing: [existing],
			n: 2,
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("2 dropped");
		expect((failure as ForgeError).details.id).toBe("polite-rejection");
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
		const failure = await generateCases({
			feature: await feature(),
			scenario: { ...scenario, status: "pending" },
			existing: [],
			n: 1,
			model: "anthropic/x",
			llm: spy,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).details.id).toBe("polite-rejection");
		expect(calls).toBe(0);
	});

	test("fields text that is not JSON, or JSON that is not an object, or an empty object, is dropped with its reason", async () => {
		for (const [fixture, reason] of [
			["fields-not-json", "expected.fields is not JSON: "],
			["fields-array", "expected.fields is JSON but not an object"],
			[
				"fields-empty",
				"oracle is fields but expected.fields is empty, so nothing would be checked",
			],
		] as const) {
			const { llm, model } = await llmFor(fixture);
			const failure = await generateCases({
				feature: await feature(),
				scenario: { ...scenario, oracle: "fields" },
				existing: [],
				n: 1,
				model,
				llm,
			}).catch((thrown: unknown) => thrown);
			expect(failure).toBeInstanceOf(ForgeError);
			expect((failure as ForgeError).message).toContain(reason);
		}
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
