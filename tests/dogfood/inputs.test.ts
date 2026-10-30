import { describe, expect, test } from "bun:test";
import {
	featureFrom,
	requiredVariable,
	scenarioFrom,
} from "../../scripts/dogfood/inputs";

const featureText = `
id: triage
purpose: label a ticket
inputs:
  - { name: message, kind: text }
output: { kind: label, labels: [refund, status] }
`;

describe("requiredVariable", () => {
	test("returns the text, or refuses naming the target and the input", () => {
		expect(
			requiredVariable({ model: "m", variables: { a: "x" } }, "a", "t"),
		).toBe("x");
		expect(() =>
			requiredVariable({ model: "m", variables: {} }, "a", "t"),
		).toThrow("the t target needs the `a` input");
	});
});

describe("featureFrom", () => {
	test("reads a feature as approved, with invariants defaulting to empty", () => {
		const feature = featureFrom(featureText);
		expect(feature.status).toBe("approved");
		expect(feature.invariants).toEqual([]);
	});
	test("refuses text that is not a feature, naming the field", () => {
		expect(() => featureFrom("id: x")).toThrow("not a valid feature");
		expect(() => featureFrom("id: x")).toThrow("purpose");
	});
	test("refuses text that is not YAML at all", () => {
		expect(() => featureFrom("a: [")).toThrow(
			"not a valid feature: it is not YAML",
		);
	});
});

describe("scenarioFrom", () => {
	test("reads a scenario as approved", () => {
		const scenario = scenarioFrom(
			"id: s\nkind: happy\noracle: label\ndescription: d\n",
		);
		expect(scenario.status).toBe("approved");
	});
	test("refuses a scenario with an unknown kind", () => {
		expect(() =>
			scenarioFrom("id: s\nkind: odd\noracle: label\ndescription: d\n"),
		).toThrow("not a valid scenario");
	});
});
