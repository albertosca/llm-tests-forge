import { describe, expect, test } from "bun:test";
import {
	frameFor,
	nextStep,
	passPreface,
	summaryLegend,
} from "../../src/cli/review-frame";
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
			"Checked as rubric: a judge model grades the answer against this sentence (free text, no fixed labels)",
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
			"Note: looks like a near-duplicate of polite-rejection-00 (flagged by the duplicate check). Reject to drop this one, approve to keep both.",
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
	test("a scenario keeps the YAML, says what its kind means and how it is checked", () => {
		const frame = frameFor({ kind: "scenario", item: scenario }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame).toEqual({
			before: [
				"Item 3 of 24 · a scenario (kind: happy, a typical, clear input)",
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
		expect(frame.before.slice(-4)).toEqual([
			"Rules the answer must respect (the feature's invariants):",
			"How these rules are used: the model that proposes cases is given them; check that the Expected follows them.",
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
		expect(text).toContain("Approve what is correct");
	});

	test("is a boxed block: a titled bar, one bullet per idea, a blank line to close", () => {
		const lines = passPreface();
		expect(lines[0]).toBe(
			"┃ READ THIS FIRST: what you are doing in this review",
		);
		expect(lines.slice(2, -1).every((line) => line.startsWith("┃  • "))).toBe(
			true,
		);
		expect(lines.slice(2, -1)).toHaveLength(5);
		expect(lines.join("\n")).toContain(
			"A scenario is a situation worth testing; a case is one concrete Input inside it.",
		);
		expect(lines[1]).toBe("┃");
		expect(lines.at(-1)).toBe("");
	});

	test("says each scenario is checked one way, so a case shows a label or a rubric, never both", () => {
		const text = passPreface().join("\n");
		expect(text).toContain("Each scenario is checked one way");
		expect(text).toContain("label, fields or rubric");
		expect(text).toContain("never both");
	});
});

describe("frameFor: what each scenario kind means", () => {
	const meanings: Record<Scenario["kind"], string> = {
		happy: "a typical, clear input",
		edge: "an unusual or extreme input, such as empty, very long or oddly formatted",
		ambiguous: "an input that can reasonably be read two ways",
		out_of_scope: "an input the feature is not meant to handle",
		adversarial: "an input that tries to trick or break the app",
		language: "an input in another language or register",
	};
	for (const [kind, meaning] of Object.entries(meanings))
		test(`${kind} is explained on the scenario's header`, () => {
			const frame = frameFor(
				{
					kind: "scenario",
					item: { ...scenario, kind: kind as Scenario["kind"] },
				},
				place,
				{ feature, scenarios: [] },
			);
			expect(frame.before[0]).toBe(
				`Item 3 of 24 · a scenario (kind: ${kind}, ${meaning})`,
			);
		});
});

describe("frameFor a case: what each label means", () => {
	const noted: Feature = {
		...feature,
		output: {
			kind: "label",
			labels: ["rejection", "acknowledgement"],
			label_notes: {
				rejection: "the company says no",
				acknowledgement: "line one\nline two",
			},
		},
	};

	test("each defined label is listed under the valid labels, a multi-line note indented", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature: noted,
			scenarios: [scenario],
		});
		const labelsIndex = frame.before.indexOf(
			"Valid labels: rejection, acknowledgement",
		);
		expect(frame.before.slice(labelsIndex, labelsIndex + 4)).toEqual([
			"Valid labels: rejection, acknowledgement",
			"  • rejection: the company says no",
			"  • acknowledgement: line one",
			"  line two",
		]);
	});

	test("a rubric scenario prints no label definitions", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature: noted,
			scenarios: [{ ...scenario, oracle: "rubric" }],
		});
		expect(frame.before.join("\n")).not.toContain("the company says no");
	});

	test("a feature with no notes adds nothing after the valid labels", () => {
		const frame = frameFor({ kind: "case", item: pendingCase }, place, {
			feature,
			scenarios: [scenario],
		});
		expect(frame.before.join("\n")).not.toContain("  • rejection");
	});
});

describe("nextStep keeps the --scenario scope", () => {
	const approved: Scenario = { ...scenario, status: "approved" };
	const none = new Set<string>();

	test("pending items: review again names the scenario", () => {
		expect(
			nextStep({
				stillPending: 2,
				scenarios: [approved],
				scenarioIdsWithCases: none,
				approvedCaseCount: 0,
				scenarioId: "polite-rejection",
			}),
		).toBe(
			"Next: 2 item(s) still pending: run llm-tests-forge review --scenario polite-rejection again.",
		);
	});

	test("cases to generate: cases names the scenario", () => {
		expect(
			nextStep({
				stillPending: 0,
				scenarios: [approved],
				scenarioIdsWithCases: none,
				approvedCaseCount: 0,
				scenarioId: "polite-rejection",
			}),
		).toBe("Next: run llm-tests-forge cases --scenario polite-rejection.");
	});
});

describe("summaryLegend", () => {
	test("says nothing when no count needs explaining", () => {
		expect(summaryLegend({ skipped: 0, stillPending: 0, reopened: 0 })).toEqual(
			[],
		);
	});

	test("explains each count that is not zero, under one heading", () => {
		const lines = summaryLegend({ skipped: 2, stillPending: 5, reopened: 1 });
		expect(lines[0]).toBe("How to read the counts below:");
		expect(lines).toHaveLength(4);
		expect(lines[1]).toStartWith("skipped: you chose to decide later");
		expect(lines[2]).toStartWith("re-opened: approved cases sent back");
		expect(lines[3]).toStartWith("still pending: everything not decided yet");
	});

	test("explains only the counts that are not zero", () => {
		expect(summaryLegend({ skipped: 0, stillPending: 3, reopened: 0 })).toEqual(
			[
				"How to read the counts below:",
				"still pending: everything not decided yet, the skipped items included, plus anything this pass did not offer (--only leaves the other kinds out).",
			],
		);
		expect(summaryLegend({ skipped: 1, stillPending: 0, reopened: 0 })).toEqual(
			[
				"How to read the counts below:",
				"skipped: you chose to decide later; the item stays pending, untouched.",
			],
		);
	});
});
