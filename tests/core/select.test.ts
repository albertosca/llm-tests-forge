import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import { forgePaths } from "../../src/core/files";
import type { Case, Feature, Scenario, Suite } from "../../src/core/schemas";
import { selectCases } from "../../src/core/select";

const paths = forgePaths("/p/.forge");
const feature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved",
};
const scenario = (
	id: string,
	status: Scenario["status"],
	oracle: Scenario["oracle"] = "label",
): Scenario => ({
	id,
	kind: "happy",
	oracle,
	description: id,
	status,
});
const withExpected = (original: Case, expected: Case["expected"]): Case => ({
	...original,
	expected,
});
const kase = (
	id: string,
	scenario: string,
	status: Case["status"],
	expected = true,
): Case => ({
	id,
	scenario,
	input: { email: id },
	status,
	generated_by: "t",
	...(expected ? { expected: { label: "rejection" } } : {}),
});
const suite = (include: string[] = []): Suite => ({
	target: {
		kind: "python",
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5"],
	},
	judges: ["google/gemini-3.5-flash"],
	repeat: 1,
	include,
});

describe("selectCases", () => {
	test("with an empty include, takes every approved or edited scenario and their approved or edited cases, in file order", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [
				scenario("a", "approved"),
				scenario("b", "edited"),
				scenario("c", "rejected"),
			],
			casesByScenario: new Map([
				[
					"a",
					[
						kase("a-01", "a", "approved"),
						kase("a-02", "a", "rejected"),
						kase("a-03", "a", "edited"),
					],
				],
				["b", [kase("b-01", "b", "approved")]],
				["c", [kase("c-01", "c", "approved")]],
			]),
			paths,
			feature,
		});
		expect(selection.scenarios.map((selected) => selected.id)).toEqual([
			"a",
			"b",
		]);
		expect(selection.cases.map((selected) => selected.id)).toEqual([
			"a-01",
			"a-03",
			"b-01",
		]);
		expect(selection.blockers).toEqual([]);
	});
	test("a pending case is a blocker naming the case and its file, and is not selected", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([
				["a", [kase("a-01", "a", "pending"), kase("a-02", "a", "approved")]],
			]),
			paths,
			feature,
		});
		expect(selection.cases.map((selected) => selected.id)).toEqual(["a-02"]);
		expect(selection.blockers).toEqual([
			"case a-01 is pending (/p/.forge/cases/a.yaml)",
		]);
	});
	test("an approved case with no expected is a blocker (hand-edited file)", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved", false)]]]),
			paths,
			feature,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"case a-01 has no expected (/p/.forge/cases/a.yaml)",
		]);
		// The review prompt asks for the missing expected.
		expect(selection.reviewable).toBe(1);
	});
	test("include narrows to the named scenarios, in include order", () => {
		const selection = selectCases({
			suite: suite(["b", "a"]),
			scenarios: [
				scenario("a", "approved"),
				scenario("b", "approved"),
				scenario("z", "approved"),
			],
			casesByScenario: new Map([
				["a", [kase("a-01", "a", "approved")]],
				["b", [kase("b-01", "b", "approved")]],
				["z", [kase("z-01", "z", "approved")]],
			]),
			paths,
			feature,
		});
		expect(selection.scenarios.map((selected) => selected.id)).toEqual([
			"b",
			"a",
		]);
		expect(selection.cases.map((selected) => selected.id)).toEqual([
			"b-01",
			"a-01",
		]);
	});
	test("an included scenario that is pending is a blocker naming scenarios.yaml, and contributes no cases", () => {
		const selection = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "pending")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved")]]]),
			paths,
			feature,
		});
		expect(selection.scenarios).toEqual([]);
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"scenario a is pending (/p/.forge/scenarios.yaml)",
		]);
	});
	test("an included scenario that is rejected is a blocker too", () => {
		const selection = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "rejected")],
			casesByScenario: new Map(),
			paths,
			feature,
		});
		expect(selection.blockers).toEqual([
			"scenario a is rejected (/p/.forge/scenarios.yaml)",
		]);
	});
	test("an include id that matches no scenario is a ForgeError naming suite.yaml and the id", () => {
		expect(() =>
			selectCases({
				suite: suite(["ghost"]),
				scenarios: [scenario("a", "approved")],
				casesByScenario: new Map(),
				paths,
				feature,
			}),
		).toThrow(ForgeError);
		try {
			selectCases({
				suite: suite(["ghost"]),
				scenarios: [],
				casesByScenario: new Map(),
				paths,
				feature,
			});
		} catch (error) {
			expect((error as ForgeError).message).toContain(
				'scenario "ghost" in suite.include not found',
			);
			expect((error as ForgeError).details).toEqual({
				file: "/p/.forge/suite.yaml",
				id: "ghost",
			});
		}
	});
	test("with an empty include, a pending scenario is a blocker and its approved case is not selected", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "pending"), scenario("b", "approved")],
			casesByScenario: new Map([
				["a", [kase("a-01", "a", "approved")]],
				["b", [kase("b-01", "b", "approved")]],
			]),
			paths,
			feature,
		});
		expect(selection.scenarios.map((selected) => selected.id)).toEqual(["b"]);
		expect(selection.cases.map((selected) => selected.id)).toEqual(["b-01"]);
		expect(selection.blockers).toEqual([
			"scenario a is pending (/p/.forge/scenarios.yaml)",
		]);
	});
	test("with an empty include, a rejected scenario stays silent", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "rejected")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved")]]]),
			paths,
			feature,
		});
		expect(selection.blockers).toEqual([]);
		expect(selection.cases).toEqual([]);
	});
	test("a pending item is reviewable; a rejected scenario is not", () => {
		const pending = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "pending")]]]),
			paths,
			feature,
		});
		expect(pending.reviewable).toBe(1);
		const pendingScenario = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "pending")],
			casesByScenario: new Map(),
			paths,
			feature,
		});
		expect(pendingScenario.blockers).toEqual([
			"scenario a is pending (/p/.forge/scenarios.yaml)",
		]);
		expect(pendingScenario.reviewable).toBe(1);
		const rejected = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "rejected")],
			casesByScenario: new Map(),
			paths,
			feature,
		});
		expect(rejected.blockers).toEqual([
			"scenario a is rejected (/p/.forge/scenarios.yaml)",
		]);
		expect(rejected.reviewable).toBe(0);
	});
	test("a label-oracle case whose expected carries only fields is a blocker, not an emitted assert", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved", "label")],
			casesByScenario: new Map([
				[
					"a",
					[
						withExpected(kase("a-01", "a", "approved"), {
							fields: { type: "rejection" },
						}),
					],
				],
			]),
			paths,
			feature,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"case a-01: oracle is label but expected.label is missing (/p/.forge/cases/a.yaml)",
		]);
		expect(selection.reviewable).toBe(1);
	});
	test("a fields-oracle case whose expected carries only a label is a blocker", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved", "fields")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved")]]]),
			paths,
			feature,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"case a-01: oracle is fields but expected.fields is missing (/p/.forge/cases/a.yaml)",
		]);
	});
	test("a rubric-oracle case whose expected carries only a label is a blocker", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved", "rubric")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved")]]]),
			paths,
			feature,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"case a-01: oracle is rubric but expected.rubric is missing (/p/.forge/cases/a.yaml)",
		]);
	});
	test("a label the feature does not list is a blocker naming the label", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved", "label")],
			casesByScenario: new Map([
				[
					"a",
					[withExpected(kase("a-01", "a", "approved"), { label: "maybe" })],
				],
			]),
			paths,
			feature,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			'case a-01: label "maybe" is not one of the feature\'s labels (/p/.forge/cases/a.yaml)',
		]);
	});
	test("an approved scenario with no cases file is selected with zero cases (report needs it for coverage)", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map(),
			paths,
			feature,
		});
		expect(selection.scenarios.map((selected) => selected.id)).toEqual(["a"]);
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([]);
	});
});

describe("selectCases: a case's input keys must be the feature's inputs", () => {
	const twoInputs: Feature = {
		...feature,
		inputs: [
			{ name: "from_addr", kind: "text" },
			{ name: "body", kind: "text" },
		],
	};
	/** What selecting one approved case with `input` throws, or null when it is selected. */
	function refusalFor(input: Record<string, string>): ForgeError | null {
		try {
			selectCases({
				suite: suite(),
				scenarios: [scenario("a", "approved")],
				casesByScenario: new Map([
					["a", [{ ...kase("a-01", "a", "approved"), input }]],
				]),
				paths,
				feature: twoInputs,
			});
			return null;
		} catch (error) {
			if (error instanceof ForgeError) return error;
			throw error;
		}
	}
	const file = "/p/.forge/cases/a.yaml";

	test("an input renamed in feature.yaml alone (missing one key, an extra one) is refused, naming the file, the case and both keys", () => {
		const refusal = refusalFor({ "from-addr": "x", body: "y" });
		expect(refusal?.reason).toBe(
			"case a-01's input keys do not match the feature's inputs (missing: from_addr; extra: from-addr); rename them in its input: or in feature.yaml",
		);
		expect(refusal?.details).toEqual({ file, id: "a-01" });
	});
	test("a missing key alone, and an extra key alone, are each refused", () => {
		expect(refusalFor({ body: "y" })?.reason).toBe(
			"case a-01's input keys do not match the feature's inputs (missing: from_addr; extra: none); rename them in its input: or in feature.yaml",
		);
		expect(
			refusalFor({ from_addr: "x", body: "y", subject: "z" })?.reason,
		).toBe(
			"case a-01's input keys do not match the feature's inputs (missing: none; extra: subject); rename them in its input: or in feature.yaml",
		);
	});
	test("several missing and extra keys are listed in order, comma-separated", () => {
		expect(refusalFor({ a: "1", b: "2" })?.reason).toBe(
			"case a-01's input keys do not match the feature's inputs (missing: from_addr, body; extra: a, b); rename them in its input: or in feature.yaml",
		);
	});
	test("keys matching the inputs in any order are selected", () => {
		expect(refusalFor({ body: "y", from_addr: "x" })).toBeNull();
	});
	test("a pending or rejected case is not checked: it is not selected either way", () => {
		const selection = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([
				[
					"a",
					[
						{ ...kase("a-01", "a", "pending"), input: { old: "x" } },
						{ ...kase("a-02", "a", "rejected"), input: { old: "x" } },
					],
				],
			]),
			paths,
			feature: twoInputs,
		});
		expect(selection.cases).toEqual([]);
		expect(selection.blockers).toEqual([
			"case a-01 is pending (/p/.forge/cases/a.yaml)",
		]);
	});
});
