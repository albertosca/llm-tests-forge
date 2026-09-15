import { describe, expect, test } from "bun:test";
import {
	CaseSchema,
	FeatureSchema,
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
};

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
		};
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
		};
		expect(CaseSchema.parse(c)).toEqual(c);
		const withExpected = {
			...c,
			expected: { label: "rejection" },
			duplicate_of: "polite-rejection-02",
		};
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
