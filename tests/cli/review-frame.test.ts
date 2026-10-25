import { describe, expect, test } from "bun:test";
import { frameFor, nextStep, passPreface } from "../../src/cli/review-frame";
import type { Case, Feature, Scenario } from "../../src/core/schemas";

const feature: Feature = {
	id: "classify-email",
	purpose: "Classify a hiring email",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved",
};

const scenario: Scenario = {
	id: "polite-rejection",
	kind: "happy",
	oracle: "label",
	description: "A courteous no",
	status: "approved",
};

const pendingCase: Case = {
	id: "polite-rejection-01",
	scenario: "polite-rejection",
	input: { email: "We will not proceed." },
	expected: { label: "rejection" },
	status: "pending",
	generated_by: "drafter-model",
};

const place = { position: 3, total: 24 };
const SHARED_KEYS =
	"keys: a approve · r reject · e edit · s skip (Enter asks before skipping)";

describe("frameFor a case", () => {
	test("names the place, the scenario, the input and the proposed expected", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame).toEqual({
			before: [
				'Item 3 of 24 · a case of scenario "polite-rejection"',
				"Scenario: A courteous no",
				"Input:",
				"  email: We will not proceed.",
				"Expected, proposed by drafter-model (you confirm or correct it):",
				"  label: rejection",
				"Checked as label: the answer must come out as this label",
				"Valid labels: rejection, acknowledgement",
			],
			showYaml: false,
			after: [
				"approve = this expected answer is right for this input · reject = drop this case · edit = fix it · skip = decide later",
				SHARED_KEYS,
			],
		});
	});

	test("a case without expected says approve or edit will ask for it", () => {
		const { expected: _expected, ...withoutExpected } = pendingCase;
		const frame = frameFor({ kind: "case", item: withoutExpected }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame.before).toContain(
			"Expected: none yet; approve or edit will ask you for it.",
		);
		expect(frame.before.join("\n")).not.toContain("proposed by");
	});

	test("a rubric oracle explains the judge and prints no valid labels", () => {
		const rubricScenario: Scenario = { ...scenario, oracle: "rubric" };
		const rubricCase: Case = {
			...pendingCase,
			expected: { rubric: "says it is a receipt" },
		};
		const frame = frameFor({ kind: "case", item: rubricCase }, place, {
			feature,
			scenarios: [rubricScenario],
		});
		expect(frame.before).toContain(
			"Checked as rubric: a judge model grades the answer against this sentence",
		);
		expect(frame.before.join("\n")).not.toContain("Valid labels");
	});

	test("a fields oracle explains that the fields must match", () => {
		const fieldsScenario: Scenario = { ...scenario, oracle: "fields" };
		const fieldsCase: Case = {
			...pendingCase,
			expected: { fields: { total: "3" } },
		};
		const frame = frameFor({ kind: "case", item: fieldsCase }, place, {
			feature,
			scenarios: [fieldsScenario],
		});
		expect(frame.before).toContain(
			"Checked as fields: the answer's fields must match these values",
		);
		expect(frame.before).toContain("  fields:");
	});

	test("a label oracle on a feature without labels prints no valid labels", () => {
		const labelless = {
			...feature,
			output: { kind: "text" },
		} as unknown as Feature;
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature: labelless,
			scenarios: [scenario],
		});
		expect(frame.before.join("\n")).not.toContain("Valid labels");
	});

	test("an unknown scenario drops the scenario and oracle lines", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [],
		});
		const text = frame.before.join("\n");
		expect(text).not.toContain("Scenario:");
		expect(text).not.toContain("Checked as");
		expect(text).not.toContain("Valid labels");
		expect(frame.before[0]).toBe(
			'Item 3 of 24 · a case of scenario "polite-rejection"',
		);
	});

	test("duplicate_of becomes a note naming the other case", () => {
		const duplicate: Case = {
			...pendingCase,
			duplicate_of: "polite-rejection-00",
		};
		const frame = frameFor({ kind: "case", item: duplicate }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame.before.at(-1)).toBe(
			"Note: looks like a near-duplicate of polite-rejection-00 (flagged by dedupe). Reject to drop this one, approve to keep both.",
		);
	});

	test("a case that is not a duplicate carries no note", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame.before.join("\n")).not.toContain("Note:");
	});
});

describe("frameFor a case: edges", () => {
	test("a long input stays on one line instead of folding at 80 columns", () => {
		const long = `${"word ".repeat(30)}end`;
		const frame = frameFor(
			{ kind: "case", item: { ...pendingCase, input: { email: long } } },
			place,
			{ feature, scenarios: [scenario] },
		);
		expect(frame.before).toContain(`  email: ${long}`);
	});

	test("the scenario shown is the case's own, not the first one", () => {
		const other: Scenario = {
			...scenario,
			id: "other",
			description: "Something else",
		};
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [other, scenario],
		});
		expect(frame.before).toContain("Scenario: A courteous no");
		expect(frame.before.join("\n")).not.toContain("Something else");
	});
});

describe("frameFor a scenario and the feature", () => {
	test("a scenario keeps the YAML and names its kind and oracle", () => {
		const frame = frameFor({ kind: "scenario", item: scenario }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame).toEqual({
			before: [
				"Item 3 of 24 · a scenario (kind: happy, oracle: label)",
				"Checked as label: the answer must come out as this label",
			],
			showYaml: true,
			after: [
				"approve = keep this scenario · reject = drop it · edit = change it · skip = decide later",
				SHARED_KEYS,
			],
		});
	});

	test("the feature keeps the YAML and its own keys line", () => {
		const frame = frameFor({ kind: "feature", item: feature }, place, {
			feature,
			scenarios: [],
		});
		expect(frame).toEqual({
			before: ["Item 3 of 24 · the feature"],
			showYaml: true,
			after: [
				"approve = this description is right · reject = drop it · edit = change it · skip = decide later",
				SHARED_KEYS,
			],
		});
	});
});

describe("nextStep", () => {
	const approvedScenario: Scenario = { ...scenario, status: "approved" };
	const none = new Set<string>();

	test("items still pending send the person back to review, with the count", () => {
		expect(
			nextStep({
				stillPending: 3,
				scenarios: [approvedScenario],
				scenarioIdsWithCases: none,
				approvedCaseCount: 1,
			}),
		).toBe("Next: 3 item(s) still pending: run llm-tests-forge review again.");
	});

	test("no scenarios yet: generate them", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [],
				scenarioIdsWithCases: none,
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge scenarios.");
	});

	test("an approved scenario with no cases: generate cases", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [approvedScenario],
				scenarioIdsWithCases: none,
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge cases.");
	});

	test("an edited scenario with no cases also needs cases", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [{ ...scenario, status: "edited" }],
				scenarioIdsWithCases: none,
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge cases.");
	});

	test("a rejected scenario with no cases needs nothing", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [
					{ ...scenario, id: "kept", status: "approved" },
					{ ...scenario, status: "rejected" },
				],
				scenarioIdsWithCases: new Set(["kept"]),
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge estimate, then emit.");
	});

	test("one scenario with cases does not hide another without", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [
					{ ...approvedScenario, id: "has-cases" },
					{ ...approvedScenario, id: "no-cases" },
				],
				scenarioIdsWithCases: new Set(["has-cases"]),
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge cases.");
	});

	test("every approved scenario has cases: estimate, then emit", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [approvedScenario],
				scenarioIdsWithCases: new Set(["polite-rejection"]),
				approvedCaseCount: 1,
			}),
		).toBe("Next: run llm-tests-forge estimate, then emit.");
	});

	test("every scenario rejected: nothing to estimate, go back to scenarios", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [{ ...scenario, status: "rejected" }],
				scenarioIdsWithCases: none,
				approvedCaseCount: 0,
			}),
		).toBe("Next: run llm-tests-forge scenarios.");
	});

	test("cases exist but none is approved or edited: generate cases again", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [approvedScenario],
				scenarioIdsWithCases: new Set(["polite-rejection"]),
				approvedCaseCount: 0,
			}),
		).toBe("Next: run llm-tests-forge cases.");
	});
});

describe("frameFor a case: invariants and continuation lines", () => {
	const withRules: Feature = {
		...feature,
		invariants: [
			"never invent a label",
			"a receipt alone is an acknowledgement",
		],
	};

	test("the feature's invariants are listed after the valid labels", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature: withRules,
			scenarios: [scenario],
		});
		expect(frame.before.slice(-3)).toEqual([
			"Rules the answer must respect (the feature's invariants):",
			"  • never invent a label",
			"  • a receipt alone is an acknowledgement",
		]);
	});

	test("a feature with no invariants prints no rules heading", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame.before.join("\n")).not.toContain("Rules the answer");
	});

	test("a multi-line description and a multi-line invariant indent their later lines", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature: { ...feature, invariants: ["first\n--- case forged ---"] },
			scenarios: [
				{ ...scenario, description: "line one\n--- case forged-99 ---" },
			],
		});
		expect(frame.before).toContain("Scenario: line one");
		expect(frame.before).toContain("  --- case forged-99 ---");
		expect(frame.before).toContain("  • first");
		expect(frame.before).toContain("  --- case forged ---");
		expect(frame.before.filter((line) => line.startsWith("---"))).toEqual([]);
	});

	test("a blank line inside an input body stays empty, with no trailing spaces", () => {
		const frame = frameFor(
			{
				kind: "case",
				item: { ...pendingCase, input: { email: "one\n\ntwo" } },
			},
			place,
			{ feature, scenarios: [scenario] },
		);
		expect(frame.before).toContain("");
		expect(frame.before.some((line) => line !== line.trimEnd())).toBe(false);
	});
});

describe("passPreface", () => {
	test("says nothing has run yet and what the Expected is for", () => {
		const text = passPreface().join("\n");
		expect(text).toContain("You are setting the right answer for each case");
		expect(text).toContain("Nothing has run yet");
		expect(text).toContain("promptfoo eval");
		expect(text).toContain("approve what is correct");
	});
});
