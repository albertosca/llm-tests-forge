import { describe, expect, test } from "bun:test";
import type { Case, Feature, Scenario } from "../../src/core/schemas";
import {
	CaseSchema,
	FeatureSchema,
	PricesSchema,
	ScenarioSchema,
	SuiteSchema,
} from "../../src/core/schemas";

const feature = {
	id: "classify-email",
	purpose: "Classify a hiring-process email",
	inputs: [{ name: "email", kind: "text", notes: "from, subject and body" }],
	output: {
		kind: "json",
		fields: ["type", "summary"],
		label_field: "type",
		labels: ["rejection", "unrelated"],
	},
	invariants: ["Answer is JSON only"],
	status: "pending",
} satisfies Feature;

describe("FeatureSchema", () => {
	test("accepts a full feature", () => {
		expect(FeatureSchema.parse(feature)).toEqual(feature);
	});
	test("defaults invariants to [] and rejects unknown status", () => {
		const { invariants: _i, ...noInv } = feature;
		expect(FeatureSchema.parse(noInv).invariants).toEqual([]);
		expect(
			FeatureSchema.safeParse({ ...feature, status: "rejected" }).success,
		).toBe(false);
	});
	test("label output requires labels", () => {
		expect(
			FeatureSchema.safeParse({ ...feature, output: { kind: "label" } })
				.success,
		).toBe(false);
		expect(
			FeatureSchema.safeParse({
				...feature,
				output: { kind: "label", labels: [] },
			}).success,
		).toBe(false);
		expect(
			FeatureSchema.safeParse({
				...feature,
				output: { kind: "label", labels: ["a", "b"] },
			}).success,
		).toBe(true);
	});
});

describe("ScenarioSchema", () => {
	test("requires kind and oracle from the enums", () => {
		const ok = {
			id: "polite-rejection",
			kind: "happy",
			oracle: "label",
			description: "a polite no",
			status: "pending",
		} satisfies Scenario;
		expect(ScenarioSchema.parse(ok)).toEqual(ok);
		expect(ScenarioSchema.safeParse({ ...ok, kind: "weird" }).success).toBe(
			false,
		);
		expect(ScenarioSchema.safeParse({ ...ok, oracle: "exact" }).success).toBe(
			false,
		);
	});
});

describe("CaseSchema", () => {
	test("expected is optional (imported cases) and duplicate_of is optional", () => {
		const c = {
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "..." },
			status: "pending",
			generated_by: "google/gemini-3.5-flash",
		} satisfies Case;
		expect(CaseSchema.parse(c)).toEqual(c);
		const withExpected = {
			...c,
			expected: { label: "rejection" },
			duplicate_of: "polite-rejection-02",
		} satisfies Case;
		expect(CaseSchema.parse(withExpected)).toEqual(withExpected);
	});
	test("expected must carry exactly one of label, fields, rubric", () => {
		const base = {
			id: "x-01",
			scenario: "x",
			input: { a: "b" },
			status: "pending",
			generated_by: "t",
		};
		expect(CaseSchema.safeParse({ ...base, expected: {} }).success).toBe(false);
		expect(
			CaseSchema.safeParse({ ...base, expected: { label: "a", rubric: "b" } })
				.success,
		).toBe(false);
		expect(
			CaseSchema.safeParse({
				...base,
				expected: { fields: { company: "Acme" } },
			}).success,
		).toBe(true);
	});
});

describe("SuiteSchema", () => {
	test("defaults repeat to 1 and include to []", () => {
		const s = SuiteSchema.parse({
			target: {
				kind: "promptfoo-python",
				entry: "forge_target.py",
				models: ["anthropic/claude-haiku-4-5"],
			},
			judges: ["anthropic/claude-sonnet-5"],
		});
		expect(s.repeat).toBe(1);
		expect(s.include).toEqual([]);
	});
});

describe("SuiteSchema.target.python", () => {
	test("is optional and, when present, a non-empty string", () => {
		const base = {
			target: {
				kind: "promptfoo-python",
				entry: "forge_target.py",
				models: ["anthropic/claude-haiku-4-5"],
			},
			judges: ["google/gemini-3.5-flash"],
		};
		expect(SuiteSchema.parse(base).target.python).toBeUndefined();
		expect(
			SuiteSchema.parse({
				...base,
				target: { ...base.target, python: ".venv/bin/python" },
			}).target.python,
		).toBe(".venv/bin/python");
		expect(
			SuiteSchema.safeParse({
				...base,
				target: { ...base.target, python: "" },
			}).success,
		).toBe(false);
	});
});

describe("PricesSchema", () => {
	const good = {
		updated: "2026-09-15",
		unit: "usd_per_million_tokens",
		sources: ["https://example.test/pricing"],
		models: { "anthropic/claude-haiku-4-5": { input: 1, output: 5 } },
	};
	test("accepts a dated table with at least one model", () => {
		expect(
			PricesSchema.parse(good).models["anthropic/claude-haiku-4-5"],
		).toEqual({
			input: 1,
			output: 5,
		});
	});
	test("rejects an empty models table", () => {
		const r = PricesSchema.safeParse({ ...good, models: {} });
		expect(r.success).toBe(false);
	});
	test("rejects an updated field that is not YYYY-MM-DD", () => {
		expect(
			PricesSchema.safeParse({ ...good, updated: "15/09/2026" }).success,
		).toBe(false);
	});
	test("rejects a negative price", () => {
		expect(
			PricesSchema.safeParse({
				...good,
				models: { m: { input: -1, output: 5 } },
			}).success,
		).toBe(false);
	});
});
