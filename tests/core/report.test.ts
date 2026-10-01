import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";
import type { Estimate } from "../../src/core/estimate";
import { readAllCases, readScenarios } from "../../src/core/files";
import { buildReport, isoDay, ReportSchema } from "../../src/core/report";
import type { Case, Prices, Scenario } from "../../src/core/schemas";
import { type PromptfooResults, readResults } from "../../src/report/results";
import { fixturePath } from "../helpers/repository";

const NOW = new Date("2026-09-15T20:00:00Z");
const FIXTURE = fixturePath("promptfoo-results-0.123.0.json");

const prices: Prices = {
	updated: "2026-09-15",
	unit: "usd_per_million_tokens",
	sources: [],
	models: {
		"anthropic/claude-haiku-4-5": { input: 1, output: 5 },
		"google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
	},
};

const scenarioFixture = (
	id: string,
	oracle: Scenario["oracle"],
	status: Scenario["status"] = "approved",
): Scenario => ({ id, kind: "happy", oracle, description: id, status });

const caseFixture = (
	id: string,
	scenario: string,
	status: Case["status"] = "approved",
): Case => ({
	id,
	scenario,
	input: { email: id },
	expected: { label: "x" },
	status,
	generated_by: "t",
});

type Row = PromptfooResults["results"]["results"][number];

function row(partial: Partial<Row> & { case: string; model: string }): Row {
	const { case: caseId, model, ...rest } = partial;
	return {
		testIdx: 0,
		success: true,
		cost: 0,
		provider: { id: "file://forge_target.py", label: model },
		metadata: { case: caseId },
		gradingResult: { pass: rest.success ?? true, componentResults: [] },
		...rest,
	};
}

function results(rows: Row[]): PromptfooResults {
	return {
		results: {
			results: rows.map((resultRow, index) => ({
				...resultRow,
				testIdx: index,
			})),
		},
		metadata: { promptfooVersion: "0.123.0" },
	};
}

const build = (
	rows: Row[],
	extra: Partial<Parameters<typeof buildReport>[0]> = {},
) => {
	const cases = extra.cases ?? [
		caseFixture("a-01", "a"),
		caseFixture("a-02", "a"),
		caseFixture("r-01", "r"),
	];
	return buildReport({
		results: results(rows),
		resultsPath: "r.json",
		scenarios: [scenarioFixture("a", "label"), scenarioFixture("r", "rubric")],
		cases,
		knownCases: [
			caseFixture("a-01", "a"),
			caseFixture("a-02", "a"),
			caseFixture("r-01", "r"),
		],
		// Every scenario the given cases belong to, unless the test overrides
		// it: this keeps every existing expectation (written before the
		// suite could leave a scenario out) reading as "the suite selected
		// everything it has cases for".
		selectedScenarios: [...new Set(cases.map((kase) => kase.scenario))],
		estimate: null,
		prices,
		baseline: null,
		now: NOW,
		...extra,
	});
};

const rubric = (
	pass: boolean,
	reason: string | undefined,
	provider: string | undefined,
) => ({
	pass,
	...(reason === undefined ? {} : { reason }),
	assertion: {
		type: "llm-rubric",
		...(provider === undefined ? {} : { provider }),
	},
});

describe("buildReport", () => {
	test("the real 0.123.0 fixture: four matched rows, two stable cases, judge tokens including reasoning", async () => {
		const report = buildReport({
			results: await readResults(FIXTURE),
			resultsPath: FIXTURE,
			scenarios: [
				scenarioFixture("ack-optional-quiz", "label"),
				scenarioFixture("out-of-scope-newsletter", "rubric"),
			],
			cases: [
				caseFixture("ack-optional-quiz-01", "ack-optional-quiz"),
				caseFixture("out-of-scope-newsletter-02", "out-of-scope-newsletter"),
			],
			knownCases: [
				caseFixture("ack-optional-quiz-01", "ack-optional-quiz"),
				caseFixture("out-of-scope-newsletter-02", "out-of-scope-newsletter"),
			],
			selectedScenarios: ["ack-optional-quiz", "out-of-scope-newsletter"],
			estimate: null,
			prices,
			baseline: null,
			now: NOW,
		});
		expect(report.rows).toBe(4);
		expect(report.matched).toBe(4);
		expect(report.unmatched).toEqual([]);
		expect(report.passRate).toBe(1);
		expect(report.cases).toEqual([
			{
				case: "ack-optional-quiz-01",
				scenario: "ack-optional-quiz",
				model: "target-haiku-4-5",
				runs: 2,
				passed: 2,
				failed: 0,
				errored: 0,
				stability: "stable",
				reasons: [],
			},
			{
				case: "out-of-scope-newsletter-02",
				scenario: "out-of-scope-newsletter",
				model: "target-haiku-4-5",
				runs: 2,
				passed: 2,
				failed: 0,
				errored: 0,
				stability: "stable",
				reasons: [],
			},
		]);
		expect(report.flaky).toEqual([]);
		expect(report.disagreements).toEqual([]);
		expect(report.targetUsageReported).toBe(false);
		expect(report.scenarios).toEqual([
			{
				scenario: "ack-optional-quiz",
				kind: "happy",
				run: 2,
				passed: 2,
				failed: 0,
				errored: 0,
			},
			{
				scenario: "out-of-scope-newsletter",
				kind: "happy",
				run: 2,
				passed: 2,
				failed: 0,
				errored: 0,
			},
		]);
		expect(report.coverage).toEqual({
			reviewedScenarios: 2,
			withRuns: 2,
			withoutCase: [],
			withoutRun: [],
			notSelected: [],
		});
		expect(report.costs).toEqual([
			{
				model: "target-haiku-4-5",
				role: "target",
				inputTokens: 0,
				outputTokens: 0,
				// The shim reported no usage at all, so there is no real cost
				// to print: zero would read as a free run. "target-haiku-4-5"
				// also has no provider prefix in prices.yaml, so it was never
				// priced as anything -- not even approximately.
				realDollars: null,
				estimatedDollars: null,
				estimatedLowDollars: null,
				estimatedHighDollars: null,
				errorPercent: null,
				approximatePrice: false,
			},
			{
				model: "google/gemini-3.5-flash",
				role: "judge",
				inputTokens: 265 + 261,
				outputTokens: 55 + 243 + (72 + 272),
				realDollars: 0.001763,
				estimatedDollars: null,
				estimatedLowDollars: null,
				estimatedHighDollars: null,
				errorPercent: null,
				approximatePrice: false,
			},
		]);
	});

	test("the committed example run: 46 of 48 rows pass, two asserts fail, nothing errored", async () => {
		// A frozen copy of the classify-email example, so curating the living
		// example under examples/ never changes the counts pinned here.
		const exampleForge = fixturePath("classify-email/.forge");
		const cases = [...(await readAllCases(exampleForge)).values()].flat();
		const report = buildReport({
			results: await readResults(fixturePath("classify-email/results.json")),
			resultsPath: "results.json",
			scenarios: await readScenarios(exampleForge),
			cases,
			knownCases: cases,
			selectedScenarios: [...new Set(cases.map((kase) => kase.scenario))],
			estimate: null,
			prices,
			baseline: null,
			now: NOW,
		});
		expect(report.rows).toBe(48);
		expect(report.matched).toBe(48);
		expect(report.passRate).toBe(0.9583);
		const failed = report.scenarios.reduce(
			(total, scenarioStat) => total + scenarioStat.failed,
			0,
		);
		const errored = report.scenarios.reduce(
			(total, scenarioStat) => total + scenarioStat.errored,
			0,
		);
		// promptfoo itself reports 2 failed and 0 errors for this file
		expect([failed, errored]).toEqual([2, 0]);
		expect(report.flaky).toEqual([]);
		expect(report.failing).toEqual([
			"empty-subject-and-minimal-body-03 @ anthropic/claude-haiku-4-5",
		]);
	});

	test("a case that never passes is named under failing, and a flaky one is not", () => {
		const report = build([
			row({ case: "a-01", model: "m", success: false }),
			row({ case: "a-01", model: "m", success: false }),
			row({ case: "a-02", model: "m", success: false }),
			row({ case: "a-02", model: "m" }),
			row({ case: "r-01", model: "m" }),
		]);
		expect(report.failing).toEqual(["a-01 @ m"]);
		expect(report.flaky).toEqual(["a-02 @ m"]);
	});

	test("a case whose every run errored is named under failing too", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "boom",
				failureReason: 2,
				response: { error: "boom" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.stability).toBe("errored");
		expect(report.failing).toEqual(["a-01 @ m"]);
	});

	test("an errored run is left out of the pass rate rather than counted against it", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({
				case: "a-02",
				model: "m",
				success: false,
				error: "overloaded",
				failureReason: 2,
				response: { error: "overloaded" },
				gradingResult: {},
			}),
		]);
		expect(report.matched).toBe(2);
		expect(report.passRate).toBe(1);
	});

	test("a run in which every row errored has a pass rate of zero, not a division by zero", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "overloaded",
				failureReason: 2,
				response: { error: "overloaded" },
				gradingResult: {},
			}),
		]);
		expect(report.passRate).toBe(0);
	});

	test("a failed assert with no component reason falls back to promptfoo's error text", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: 1,
				error: "Assertion failed",
				gradingResult: { pass: false },
			}),
		]);
		expect(report.cases[0]?.stability).toBe("failing");
		expect(report.cases[0]?.reasons).toEqual(["Assertion failed"]);
	});

	test("a row whose failureReason is null is judged by response.error, which only a provider failure sets", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: null,
				error: "connection reset",
				response: { error: "connection reset" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.stability).toBe("errored");
		expect(report.cases[0]?.errored).toBe(1);
	});

	test("a row naming a case that exists but is not selected says so", () => {
		const report = build([row({ case: "a-01", model: "m" })], {
			cases: [caseFixture("a-01", "a")],
			knownCases: [
				caseFixture("a-01", "a"),
				caseFixture("a-02", "a", "rejected"),
			],
			results: results([
				row({ case: "a-01", model: "m" }),
				row({ case: "a-02", model: "m" }),
			]),
		});
		expect(report.unmatched).toEqual([
			"row 1 (testIdx 1): m: a-02 (not in the current selection)",
		]);
	});

	test("a row naming no case the files know keeps the bare wording", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "ghost-01", model: "m" }),
		]);
		expect(report.unmatched).toEqual(["row 1 (testIdx 1): m: ghost-01"]);
	});

	test("a case that passes once and fails twice is flaky, and the repeated reason is kept once", () => {
		const failing = () =>
			row({
				case: "a-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [
						{
							pass: false,
							reason: 'type was "offer"',
							assertion: { type: "javascript" },
						},
					],
				},
			});
		const report = build([
			row({ case: "a-01", model: "m" }),
			failing(),
			// the same failure again: one reason to read, not two
			failing(),
		]);
		expect(report.cases).toEqual([
			{
				case: "a-01",
				scenario: "a",
				model: "m",
				runs: 3,
				passed: 1,
				failed: 2,
				errored: 0,
				stability: "flaky",
				reasons: ['type was "offer"'],
			},
		]);
		expect(report.flaky).toEqual(["a-01 @ m"]);
		expect(report.passRate).toBe(0.3333);
	});

	test("every run erroring is errored; every run failing is failing", () => {
		// The measured provider-error shape: promptfoo sets failureReason 2
		// and repeats the message under `response.error`.
		const providerError = () =>
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "boom",
				failureReason: 2,
				response: { error: "boom" },
				gradingResult: {},
			});
		const report = build([
			providerError(),
			providerError(),
			row({ case: "a-02", model: "m", success: false }),
			row({ case: "a-02", model: "m", success: false }),
		]);
		expect(
			report.cases.map((caseRun) => [
				caseRun.case,
				caseRun.stability,
				caseRun.reasons,
			]),
		).toEqual([
			["a-01", "errored", ["boom"]],
			["a-02", "failing", []],
		]);
		expect(report.cases[0]?.errored).toBe(2);
		expect(report.passRate).toBe(0);
		expect(report.flaky).toEqual([]);
	});

	test("a failed assert is a failure, not an error, even though promptfoo puts its reason in error", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: 1,
				error: "the rubric requires both fields to be null",
				gradingResult: {
					pass: false,
					componentResults: [
						{
							pass: false,
							reason: "the rubric requires both fields to be null",
							assertion: { type: "llm-rubric" },
						},
					],
				},
			}),
		]);
		expect(report.cases[0]?.failed).toBe(1);
		expect(report.cases[0]?.errored).toBe(0);
		expect(report.cases[0]?.stability).toBe("failing");
		expect(report.cases[0]?.reasons).toEqual([
			"the rubric requires both fields to be null",
		]);
	});

	test("a provider that errored is an error, and its message is the reason", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: 2,
				error: "boom",
				response: { error: "boom" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.errored).toBe(1);
		expect(report.cases[0]?.failed).toBe(0);
		expect(report.cases[0]?.stability).toBe("errored");
		expect(report.cases[0]?.reasons).toEqual(["boom"]);
	});

	test("a file with no failureReason falls back to response.error to tell the two apart", () => {
		const errored = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "Error: No candidates returned",
				response: { error: "Error: No candidates returned" },
				gradingResult: {},
			}),
		]);
		expect(errored.cases[0]?.stability).toBe("errored");
		expect(errored.cases[0]?.errored).toBe(1);

		const failed = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "output did not match",
				gradingResult: { pass: false, componentResults: [] },
			}),
		]);
		expect(failed.cases[0]?.stability).toBe("failing");
		expect(failed.cases[0]?.failed).toBe(1);
		// no component named a reason, so the row's own error stands in
		expect(failed.cases[0]?.reasons).toEqual(["output did not match"]);
	});

	test("an unlabelled provider this forge wrote is named the forge's way", () => {
		const report = build([
			row({
				case: "a-01",
				model: "unused",
				provider: { id: "anthropic:messages:claude-haiku-4-5" },
			}),
		]);
		expect(report.cases[0]?.model).toBe("anthropic/claude-haiku-4-5");
		expect(report.costs[0]?.model).toBe("anthropic/claude-haiku-4-5");
	});

	test("a provider with no label is named by its id", () => {
		const report = build([
			row({
				case: "a-01",
				model: "unused",
				provider: { id: "file://forge_target.py" },
			}),
		]);
		expect(report.cases[0]?.model).toBe("file://forge_target.py");
		expect(report.costs[0]?.model).toBe("file://forge_target.py");
		expect(report.flaky).toEqual([]);
	});

	test("a failing component with no reason contributes nothing to reasons", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [
						{ pass: false, assertion: { type: "javascript" } },
					],
				},
			}),
		]);
		// Strict: a loose toEqual takes [undefined] for [], and an undefined
		// reason is written to report.json as null.
		expect(report.cases[0]?.reasons).toStrictEqual([]);
		expect(report.cases[0]?.stability).toBe("failing");
	});

	test("unmatched rows are listed with their row number and never counted", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "ghost-01", model: "m" }),
			row({ case: "ignored", model: "m", metadata: undefined }),
		]);
		expect(report.unmatched).toEqual([
			"row 1 (testIdx 1): m: ghost-01",
			"row 2 (testIdx 2): m: no metadata.case",
		]);
		expect(report.rows).toBe(3);
		expect(report.matched).toBe(1);
		expect(report.passRate).toBe(1);
	});

	test("zero matched rows is a ForgeError naming the results file", () => {
		let caught: unknown;
		try {
			build([row({ case: "ghost-01", model: "m" })]);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain(
			"a config llm-tests-forge emitted",
		);
		expect((caught as ForgeError).details.file).toBe("r.json");
	});

	test("scenario stats cover every reviewed scenario in file order, and coverage names the ones with no case", () => {
		const report = build([row({ case: "a-01", model: "m" })], {
			scenarios: [
				scenarioFixture("a", "label"),
				scenarioFixture("r", "rubric"),
				scenarioFixture("p", "label", "pending"),
			],
			cases: [
				caseFixture("a-01", "a"),
				caseFixture("a-02", "a"),
				caseFixture("r-01", "r", "rejected"),
			],
			knownCases: [
				caseFixture("a-01", "a"),
				caseFixture("a-02", "a"),
				caseFixture("r-01", "r", "rejected"),
			],
		});
		expect(report.scenarios).toEqual([
			{
				scenario: "a",
				kind: "happy",
				run: 1,
				passed: 1,
				failed: 0,
				errored: 0,
			},
			{
				scenario: "r",
				kind: "happy",
				run: 0,
				passed: 0,
				failed: 0,
				errored: 0,
			},
		]);
		expect(report.coverage).toEqual({
			reviewedScenarios: 2,
			withRuns: 1,
			withoutCase: ["r"],
			withoutRun: [],
			notSelected: [],
		});
	});

	test("an edited scenario and an edited case count exactly like approved ones", () => {
		const report = build(
			[row({ case: "a-01", model: "m" }), row({ case: "e-01", model: "m" })],
			{
				scenarios: [
					scenarioFixture("a", "label"),
					scenarioFixture("e", "label", "edited"),
				],
				cases: [caseFixture("a-01", "a"), caseFixture("e-01", "e", "edited")],
				knownCases: [
					caseFixture("a-01", "a"),
					caseFixture("e-01", "e", "edited"),
				],
			},
		);
		expect(report.scenarios).toEqual([
			{
				scenario: "a",
				kind: "happy",
				run: 1,
				passed: 1,
				failed: 0,
				errored: 0,
			},
			{
				scenario: "e",
				kind: "happy",
				run: 1,
				passed: 1,
				failed: 0,
				errored: 0,
			},
		]);
		expect(report.coverage).toEqual({
			reviewedScenarios: 2,
			withRuns: 2,
			withoutCase: [],
			withoutRun: [],
			notSelected: [],
		});
		expect(report.cases.map((caseRun) => caseRun.case)).toEqual([
			"a-01",
			"e-01",
		]);
	});

	test("two judges that disagree are reported; agreeing judges and a lone judge are not", () => {
		const report = build([
			row({
				case: "r-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [
						rubric(true, "ok", "google:gemini-3.5-flash"),
						rubric(false, "no", "anthropic:messages:claude-sonnet-5"),
					],
				},
			}),
			row({
				case: "r-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [
						rubric(true, "ok", "google:gemini-3.5-flash"),
						rubric(true, "fine", "anthropic:messages:claude-sonnet-5"),
					],
				},
			}),
			row({
				case: "a-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [rubric(true, "solo", "google:gemini-3.5-flash")],
				},
			}),
		]);
		expect(report.disagreements).toEqual([
			{
				case: "r-01",
				model: "m",
				occurrences: 1,
				judges: [
					{ judge: "google/gemini-3.5-flash", pass: true, reason: "ok" },
					{ judge: "anthropic/claude-sonnet-5", pass: false, reason: "no" },
				],
			},
		]);
	});

	test("a judge provider the forge did not write keeps its raw id, and a missing one is named unknown", () => {
		const report = build([
			row({
				case: "r-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [
						rubric(true, undefined, "bedrock:anthropic.claude"),
						rubric(false, "no", undefined),
					],
				},
			}),
		]);
		expect(report.disagreements).toEqual([
			{
				case: "r-01",
				model: "m",
				occurrences: 1,
				judges: [
					{ judge: "bedrock:anthropic.claude", pass: true, reason: "" },
					{ judge: "unknown judge", pass: false, reason: "no" },
				],
			},
		]);
	});

	test("judge reasoning is added to the output only where the provider reports it apart: Google and Vertex's Gemini, never Anthropic nor Vertex's Claude", () => {
		// promptfoo 0.123.0 maps Anthropic's `output_tokens` to `completion`
		// and its `thinking_tokens` to `completionDetails.reasoning`, so the
		// reasoning is already inside `completion`; Google reports the two
		// apart. Numbers from the committed runs' rubric components.
		const judged = (provider: string, completion: number, reasoning: number) =>
			row({
				case: "r-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [
						{
							...rubric(true, undefined, provider),
							tokensUsed: {
								prompt: 10,
								completion,
								completionDetails: { reasoning },
							},
						},
					],
				},
			});
		const report = build([
			judged("anthropic:messages:claude-sonnet-5", 123, 44),
			judged("google:gemini-3.5-flash", 55, 243),
			judged("vertex:gemini-3.5-flash", 72, 272),
			// promptfoo maps Vertex's Claude through the Anthropic mapping.
			judged("vertex:claude-sonnet-4-5@20250929", 90, 30),
		]);
		const outputOf = (model: string) =>
			report.costs.find(
				(modelCost) => modelCost.role === "judge" && modelCost.model === model,
			)?.outputTokens;
		expect(outputOf("anthropic/claude-sonnet-5")).toBe(123);
		expect(outputOf("google/gemini-3.5-flash")).toBe(55 + 243);
		expect(outputOf("vertex:gemini-3.5-flash")).toBe(72 + 272);
		expect(outputOf("vertex:claude-sonnet-4-5@20250929")).toBe(90);

		// A Google component recorded without completionDetails (an older
		// promptfoo) has no reasoning to add, and must not crash on it.
		const withoutDetails = build([
			row({
				case: "r-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [
						{
							...rubric(true, undefined, "google:gemini-3.5-flash"),
							tokensUsed: { prompt: 10, completion: 55 },
						},
					],
				},
			}),
		]);
		expect(
			withoutDetails.costs.find((modelCost) => modelCost.role === "judge")
				?.outputTokens,
		).toBe(55);
	});

	test("a judge whose provider has no row in prices.yaml gets no real dollar figure", () => {
		const report = build([
			row({
				case: "r-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [rubric(false, "no", "ollama/llama3")],
				},
			}),
		]);
		const judge = report.costs.find((modelCost) => modelCost.role === "judge");
		expect(judge?.model).toBe("ollama/llama3");
		expect(judge?.realDollars).toBeNull();
		expect(judge?.approximatePrice).toBe(false);
	});

	test("an unpriced target that reports its own cost is believed, needing no rate", () => {
		const report = build([
			row({
				case: "a-01",
				model: "ollama/llama3",
				cost: 0.0055,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(report.costs[0]?.realDollars).toBe(0.0055);
		expect(report.costs[0]?.approximatePrice).toBe(false);
	});

	test("an unpriced target with tokens but no cost has no real dollar figure to compute", () => {
		const report = build([
			row({
				case: "a-01",
				model: "ollama/llama3",
				cost: 0,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(report.costs[0]?.realDollars).toBeNull();
		expect(report.costs[0]?.approximatePrice).toBe(false);
	});

	test("a target that reports cost uses it; tokens are summed either way", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-4-5",
				cost: 0.001,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(report.costs).toEqual([
			{
				model: "anthropic/claude-haiku-4-5",
				role: "target",
				inputTokens: 400,
				outputTokens: 80,
				realDollars: 0.001,
				estimatedDollars: null,
				estimatedLowDollars: null,
				estimatedHighDollars: null,
				errorPercent: null,
				approximatePrice: false,
			},
		]);
		expect(report.targetUsageReported).toBe(true);
	});

	test("a target that reports tokens but no cost is priced from the table", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-4-5",
				cost: 0,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(report.costs[0]?.realDollars).toBe((400 * 1 + 80 * 5) / 1e6);
		expect(report.costs[0]?.approximatePrice).toBe(false);
		expect(report.targetUsageReported).toBe(true);
	});

	test("a reported cost is never marked approximate, even for a model the table has never heard of", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-9",
				cost: 0.001,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		// priceFor would approximate this model, but no price was looked up:
		// promptfoo billed the call and told us what it cost.
		expect(report.costs[0]?.realDollars).toBe(0.001);
		expect(report.costs[0]?.approximatePrice).toBe(false);
	});

	test("the estimate line for the same model and role gives the error percent", () => {
		const estimate: Estimate = {
			lines: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					calls: 2,
					inputTokens: 300,
					inputTokensLow: 285,
					inputTokensHigh: 343,
					outputTokens: 40,
					outputTokensLow: 20,
					outputTokensHigh: 50,
					dollars: 0.0005,
					dollarsLow: 0.0003,
					dollarsHigh: 0.0008,
					pricedAs: "anthropic/claude-haiku-4-5",
					approximate: false,
					priced: true,
				},
			],
			cases: 1,
			rubricCases: 0,
			totalDollars: 0.0005,
			totalDollarsLow: 0.0003,
			totalDollarsHigh: 0.0008,
			pricesUpdated: "2026-09-15",
			notes: [],
		};
		const report = build(
			[
				row({
					case: "a-01",
					model: "anthropic/claude-haiku-4-5",
					cost: 0.001,
					tokenUsage: { prompt: 400, completion: 80, total: 480 },
				}),
			],
			{ estimate },
		);
		expect(report.costs[0]?.estimatedDollars).toBe(0.0005);
		expect(report.costs[0]?.estimatedLowDollars).toBe(0.0003);
		expect(report.costs[0]?.estimatedHighDollars).toBe(0.0008);
		expect(report.costs[0]?.errorPercent).toBe(100);

		const other = build([row({ case: "a-01", model: "m", cost: 0.001 })], {
			estimate,
		});
		expect(other.costs[0]?.estimatedDollars).toBeNull();
		expect(other.costs[0]?.estimatedLowDollars).toBeNull();
		expect(other.costs[0]?.estimatedHighDollars).toBeNull();
		expect(other.costs[0]?.errorPercent).toBeNull();
	});

	test("an unpriced estimate line reports no estimated dollars, not zero", () => {
		// `dollars` is 0 on a line whose provider has no row in prices.yaml,
		// and 0 read as a dollar figure says the run was free.
		const estimate: Estimate = {
			lines: [
				{
					model: "ollama/llama3",
					role: "target",
					calls: 2,
					inputTokens: 300,
					inputTokensLow: 285,
					inputTokensHigh: 343,
					outputTokens: 40,
					outputTokensLow: 20,
					outputTokensHigh: 50,
					dollars: 0,
					dollarsLow: 0,
					dollarsHigh: 0,
					pricedAs: "ollama/llama3",
					approximate: true,
					priced: false,
				},
			],
			cases: 1,
			rubricCases: 0,
			totalDollars: 0,
			totalDollarsLow: 0,
			totalDollarsHigh: 0,
			pricesUpdated: "2026-09-15",
			notes: [],
		};
		const report = build(
			[
				row({
					case: "a-01",
					model: "ollama/llama3",
					cost: 0.001,
					tokenUsage: { prompt: 400, completion: 80, total: 480 },
				}),
			],
			{ estimate },
		);
		expect(report.costs[0]?.estimatedDollars).toBeNull();
		expect(report.costs[0]?.estimatedLowDollars).toBeNull();
		expect(report.costs[0]?.estimatedHighDollars).toBeNull();
		expect(report.costs[0]?.errorPercent).toBeNull();
	});

	test("a report.json written before the estimate range still loads as a baseline, its range null", async () => {
		// The frozen classify-email report was written by the forge before
		// the range existed: its costs carry only `estimatedDollars`.
		const data = JSON.parse(
			await readFile(fixturePath("classify-email/.forge/report.json"), "utf8"),
		);
		expect(data.costs[0]).not.toHaveProperty("estimatedLowDollars");
		const parsed = ReportSchema.parse(data);
		expect(
			parsed.costs.map((modelCost) => [
				modelCost.estimatedDollars,
				modelCost.estimatedLowDollars,
				modelCost.estimatedHighDollars,
			]),
		).toEqual([
			[0.051836, null, null],
			[0.014808, null, null],
		]);
	});

	test("an estimate of zero dollars gives no error percent to divide by", () => {
		const estimate: Estimate = {
			lines: [
				{
					model: "m",
					role: "target",
					calls: 0,
					inputTokens: 0,
					inputTokensLow: 0,
					inputTokensHigh: 0,
					outputTokens: 0,
					outputTokensLow: 0,
					outputTokensHigh: 0,
					dollars: 0,
					dollarsLow: 0,
					dollarsHigh: 0,
					pricedAs: "m",
					approximate: true,
					priced: true,
				},
			],
			cases: 0,
			rubricCases: 0,
			totalDollars: 0,
			totalDollarsLow: 0,
			totalDollarsHigh: 0,
			pricesUpdated: "2026-09-15",
			notes: [],
		};
		const report = build([row({ case: "a-01", model: "m", cost: 0.001 })], {
			estimate,
		});
		expect(report.costs[0]?.estimatedDollars).toBe(0);
		expect(report.costs[0]?.errorPercent).toBeNull();
	});

	test("a baseline names what regressed and what was fixed, and ignores pairs only one side has", () => {
		const before = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "a-02", model: "m", success: false }),
			row({ case: "r-01", model: "m" }),
		]);
		const report = build(
			[
				row({ case: "a-01", model: "m", success: false }),
				row({ case: "a-02", model: "m" }),
				// unchanged since the baseline, so it belongs to neither list
				row({ case: "r-01", model: "m" }),
				// the baseline never ran this model, so the pair is ignored
				row({ case: "a-01", model: "m2" }),
			],
			{ baseline: before },
		);
		expect(report.baseline).toEqual({
			regressions: [
				{ case: "a-01", model: "m", before: "stable", after: "failing" },
			],
			fixed: [{ case: "a-02", model: "m", before: "failing", after: "stable" }],
			onlyInBaseline: [],
		});
		expect(before.baseline).toBeNull();
	});

	test("a baseline pair this run does not have is listed under onlyInBaseline, never as a change", () => {
		const before = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "a-02", model: "m", success: false }),
		]);
		// After `llm-tests-forge move --scenario a b` every row of this run carries
		// the new ids; the baseline's pairs say nothing about them.
		const report = build([row({ case: "r-01", model: "m" })], {
			baseline: before,
		});
		expect(report.baseline).toEqual({
			regressions: [],
			fixed: [],
			onlyInBaseline: [
				{ case: "a-01", model: "m" },
				{ case: "a-02", model: "m" },
			],
		});
	});

	test("a baseline written before onlyInBaseline existed parses with an empty list", () => {
		const before = build([row({ case: "a-01", model: "m" })]);
		const report = build([row({ case: "a-01", model: "m" })], {
			baseline: before,
		});
		const { onlyInBaseline, ...withoutList } = report.baseline ?? {
			onlyInBaseline: [],
		};
		expect(onlyInBaseline).toEqual([]);
		expect(
			ReportSchema.parse({ ...report, baseline: withoutList }).baseline
				?.onlyInBaseline,
		).toEqual([]);
	});

	test("coverage names the reviewed scenarios that have cases but no run, apart from those with no case", () => {
		// `a` has a reviewed case and rows; `r` has a reviewed case and no
		// row (its rows carry an old id after a rename); `n` has no case.
		const report = build([row({ case: "a-01", model: "m" })], {
			scenarios: [
				scenarioFixture("a", "label"),
				scenarioFixture("r", "rubric"),
				scenarioFixture("n", "label"),
			],
			cases: [caseFixture("a-01", "a"), caseFixture("r-01", "r")],
			knownCases: [caseFixture("a-01", "a"), caseFixture("r-01", "r")],
		});
		expect(report.coverage).toEqual({
			reviewedScenarios: 3,
			withRuns: 1,
			withoutCase: ["n"],
			withoutRun: ["r"],
			notSelected: [],
		});
	});

	test("coverage names the reviewed scenarios the suite did not select, and a baseline without notSelected parses with an empty list", () => {
		// `include: [a]` selects only `a`; `r` has a reviewed case on disk
		// that this run never priced or ran, so it lands under `notSelected`
		// rather than `withoutRun`, which stays true only of scenarios the
		// suite did select.
		const report = build([row({ case: "a-01", model: "m" })], {
			cases: [caseFixture("a-01", "a")],
			selectedScenarios: ["a"],
		});
		expect(report.coverage).toEqual({
			reviewedScenarios: 2,
			withRuns: 1,
			withoutCase: [],
			withoutRun: [],
			notSelected: ["r"],
		});
		const { notSelected, ...coverage } = report.coverage;
		expect(
			ReportSchema.parse({ ...report, coverage }).coverage.notSelected,
		).toEqual([]);
	});

	test("a baseline whose coverage has no withoutRun parses with an empty list", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		// The default fixture has `r` reviewed with a case and no row.
		const { withoutRun, ...coverage } = report.coverage;
		expect(withoutRun).toEqual(["r"]);
		expect(
			ReportSchema.parse({ ...report, coverage }).coverage.withoutRun,
		).toEqual([]);
	});

	test("cases are ordered by model name, then by the order of the cases file", () => {
		const report = build([
			row({ case: "a-02", model: "m2" }),
			row({ case: "a-01", model: "m1" }),
			row({ case: "a-02", model: "m1" }),
			row({ case: "a-01", model: "m2" }),
		]);
		expect(
			report.cases.map((caseRun) => `${caseRun.case}@${caseRun.model}`),
		).toEqual(["a-01@m1", "a-02@m1", "a-01@m2", "a-02@m2"]);
	});

	test("generatedAt is the clock passed in, and an absent promptfoo version is null", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		expect(report.generatedAt).toBe(NOW.toISOString());
		expect(report.promptfooVersion).toBe("0.123.0");

		const bare = build([], {
			results: {
				results: { results: [row({ case: "a-01", model: "m" })] },
			},
		});
		expect(bare.promptfooVersion).toBeNull();
	});

	test("ranAt is the time promptfoo recorded in results.json, and null when an older results.json has none", () => {
		const rows = [row({ case: "a-01", model: "m" })];
		const withTimestamp = build([], {
			results: {
				results: { timestamp: "2026-09-25T14:48:00.200Z", results: rows },
			},
		});
		expect(withTimestamp.ranAt).toBe("2026-09-25T14:48:00.200Z");
		expect(withTimestamp.generatedAt).toBe(NOW.toISOString());

		const withoutTimestamp = build(rows);
		expect(withoutTimestamp.ranAt).toBeNull();
	});

	test("readResults keeps results.timestamp from a real promptfoo file", async () => {
		const parsed = await readResults(FIXTURE);
		expect(parsed.results.timestamp).toBe("2026-09-15T19:07:12.028Z");
	});

	/** The real fixture with results.timestamp replaced by `value`, written to a temporary file. */
	async function resultsWithTimestamp(value: unknown): Promise<string> {
		const data = JSON.parse(await readFile(FIXTURE, "utf8"));
		data.results.timestamp = value;
		const directory = await mkdtemp(join(tmpdir(), "forge-results-"));
		const file = join(directory, "results.json");
		await writeFile(file, JSON.stringify(data));
		return file;
	}

	/** ranAt of a report built from the parsed file's timestamp over rows that match a case. */
	const ranAtOf = (parsed: PromptfooResults): string | null =>
		build([], {
			results: {
				results: {
					timestamp: parsed.results.timestamp,
					results: [row({ case: "a-01", model: "m" })],
				},
			},
		}).ranAt;

	test("a results.json whose timestamp is null still parses, with ranAt null", async () => {
		const parsed = await readResults(await resultsWithTimestamp(null));
		expect(parsed.results.timestamp).toBeUndefined();
		expect(ranAtOf(parsed)).toBeNull();
	});

	test("a results.json whose timestamp is a number still parses, with ranAt null", async () => {
		const parsed = await readResults(await resultsWithTimestamp(1758814080000));
		expect(parsed.results.timestamp).toBeUndefined();
		expect(ranAtOf(parsed)).toBeNull();
	});

	test("an empty results.timestamp does not become ranAt", async () => {
		const parsed = await readResults(await resultsWithTimestamp(""));
		expect(ranAtOf(parsed)).toBeNull();
	});

	test("a results.timestamp that is not a date does not become ranAt", () => {
		const rows = [row({ case: "a-01", model: "m" })];
		const report = build([], {
			results: { results: { timestamp: "last tuesday", results: rows } },
		});
		expect(report.ranAt).toBeNull();
	});

	test("a results.timestamp Date.parse takes but that is not ISO does not become ranAt: status could not show it", () => {
		const rows = [row({ case: "a-01", model: "m" })];
		const report = build([], {
			results: { results: { timestamp: "Tue Sep 16 2026", results: rows } },
		});
		expect(report.ranAt).toBeNull();
	});

	test("a hand-edited report.json whose ranAt is not a string still parses, with ranAt null", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		for (const edited of [5, true, {}, ["2026-09-25"]]) {
			const parsed = ReportSchema.parse({ ...report, ranAt: edited });
			expect(parsed.ranAt).toBeNull();
			expect(parsed.rows).toBe(report.rows);
		}
	});

	test("a report.json written before ranAt existed still parses as a baseline, with ranAt null", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		const { ranAt, ...old } = report;
		expect(ranAt).toBeNull();
		expect(ReportSchema.parse(old).ranAt).toBeNull();

		const empty = build([], {
			results: {
				results: { results: [row({ case: "a-01", model: "m" })] },
				metadata: {},
			},
		});
		expect(empty.promptfooVersion).toBeNull();
	});
	test("a baseline written before `failing` existed parses with an empty list", () => {
		const { failing, ...withoutFailing } = build([
			row({ case: "a-01", model: "m", success: false }),
		]);
		expect(failing).toEqual(["a-01 @ m"]);
		expect(ReportSchema.parse(withoutFailing).failing).toEqual([]);
	});
	test("a baseline written before `failingPairs` existed parses with an empty list", () => {
		const { failingPairs, ...withoutPairs } = build([
			row({ case: "a-01", model: "m", success: false }),
		]);
		expect(failingPairs).toEqual([{ case: "a-01", model: "m" }]);
		expect(ReportSchema.parse(withoutPairs).failingPairs).toEqual([]);
	});
	test("failingPairs tells apart two pairs whose `failing` strings collide on a case id containing ` @ `", () => {
		const cases = [caseFixture("x @ m", "a"), caseFixture("x", "a")];
		const report = build(
			[
				row({ case: "x @ m", model: "n", success: false }),
				row({ case: "x", model: "m @ n", success: false }),
			],
			{ cases, knownCases: cases },
		);
		// The display strings are the same entry twice; the pairs are not.
		expect(report.failing).toEqual(["x @ m @ n", "x @ m @ n"]);
		expect(report.failingPairs).toEqual([
			{ case: "x", model: "m @ n" },
			{ case: "x @ m", model: "n" },
		]);
	});
	test("a baseline whose coverage still says `approvedScenarios` reads back as `reviewedScenarios`", () => {
		// The key was renamed during the backlog sweep; every report.json
		// written before it carries the old spelling, and rejecting those
		// makes `--baseline` refuse the only files a person has.
		const report = build([row({ case: "a-01", model: "m" })]);
		const { reviewedScenarios, ...rest } = report.coverage;
		const old = { ...report, coverage: { ...rest, approvedScenarios: 4 } };
		const parsed = ReportSchema.parse(old);
		expect(parsed.coverage.reviewedScenarios).toBe(4);
		expect(parsed.coverage.withRuns).toBe(report.coverage.withRuns);
		// 2, not the 4 the old key carries: the number really came from the
		// old spelling rather than from the report being re-derived.
		expect(reviewedScenarios).toBe(2);
	});
	test("a coverage carrying both spellings keeps the new one", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		const both = {
			...report,
			coverage: { ...report.coverage, approvedScenarios: 99 },
		};
		expect(ReportSchema.parse(both).coverage.reviewedScenarios).toBe(
			report.coverage.reviewedScenarios,
		);
	});
	test("a coverage carrying neither spelling is still refused", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		const { reviewedScenarios, ...rest } = report.coverage;
		const parsed = ReportSchema.safeParse({ ...report, coverage: rest });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.path.join(".")).toBe(
			"coverage.reviewedScenarios",
		);
	});
	test("two unmatched rows carrying the same testIdx are told apart by position", () => {
		// promptfoo repeats testIdx across repeats, so the index alone names
		// two different rows the same way.
		const report = build([], {
			results: {
				results: {
					results: [
						{ ...row({ case: "a-01", model: "m" }), testIdx: 7 },
						{ ...row({ case: "ghost-01", model: "m" }), testIdx: 7 },
						{ ...row({ case: "ghost-01", model: "m" }), testIdx: 7 },
					],
				},
				metadata: { promptfooVersion: "0.123.0" },
			},
		});
		expect(report.unmatched).toEqual([
			"row 1 (testIdx 7): m: ghost-01",
			"row 2 (testIdx 7): m: ghost-01",
		]);
	});
	test("zero matched rows names the first metadata.case the file did carry", () => {
		let caught: unknown;
		try {
			build([
				row({ case: "ghost-01", model: "m" }),
				row({ case: "ghost-02", model: "m" }),
			]);
		} catch (error) {
			caught = error;
		}
		expect((caught as ForgeError).message).toBe(
			'no result matches a case in .forge/cases (first metadata.case seen: "ghost-01", 2 rows); was this results.json produced from a config llm-tests-forge emitted? (file: r.json)',
		);
	});

	test("zero matched rows with no metadata.case anywhere says none rather than quoting an id", () => {
		let caught: unknown;
		try {
			build([
				row({ case: "x", model: "m", metadata: undefined }),
				row({ case: "y", model: "m", metadata: {} }),
			]);
		} catch (error) {
			caught = error;
		}
		expect((caught as ForgeError).message).toBe(
			"no result matches a case in .forge/cases (first metadata.case seen: none, 2 rows); was this results.json produced from a config llm-tests-forge emitted? (file: r.json)",
		);
	});
	test("a case that passes one run and errors another is partly-errored, not flaky", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "overloaded",
				failureReason: 2,
				response: { error: "overloaded" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.stability).toBe("partly-errored");
		expect(report.failing).toEqual(["a-01 @ m"]);
		expect(report.flaky).toEqual([]);
	});

	test("a case that also failed an assert stays flaky even with an error among its runs", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "a-01", model: "m", success: false }),
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "overloaded",
				failureReason: 2,
				response: { error: "overloaded" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.stability).toBe("flaky");
		expect(report.flaky).toEqual(["a-01 @ m"]);
		expect(report.failing).toEqual([]);
	});

	test("a case that only fails and errors, never passing, is failing", () => {
		const report = build([
			row({ case: "a-01", model: "m", success: false }),
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "overloaded",
				failureReason: 2,
				response: { error: "overloaded" },
				gradingResult: {},
			}),
		]);
		expect(report.cases[0]?.stability).toBe("failing");
		expect(report.failing).toEqual(["a-01 @ m"]);
	});
	test("a case that disagrees on every repeat is one entry counting the repeats", () => {
		const disagreeing = (first: string, second: string) =>
			row({
				case: "r-01",
				model: "m",
				success: false,
				gradingResult: {
					pass: false,
					componentResults: [
						rubric(true, first, "google:gemini-3.5-flash"),
						rubric(false, second, "anthropic:messages:claude-sonnet-5"),
					],
				},
			});
		const report = build([
			disagreeing("ok", "no"),
			disagreeing("still ok", "still no"),
		]);
		// The verdicts kept are the first disagreeing run's; the second run's
		// wording is counted, not stored.
		expect(report.disagreements).toEqual([
			{
				case: "r-01",
				model: "m",
				occurrences: 2,
				judges: [
					{ judge: "google/gemini-3.5-flash", pass: true, reason: "ok" },
					{ judge: "anthropic/claude-sonnet-5", pass: false, reason: "no" },
				],
			},
		]);
	});
});

/** A row whose provider itself failed, the way promptfoo 0.123.0 records it. */
const erroredRow = (caseId: string, model: string): Row =>
	row({
		case: caseId,
		model,
		success: false,
		error: "overloaded",
		failureReason: 2,
		response: { error: "overloaded" },
		gradingResult: {},
	});

/** A priced estimate line for `model` in `role`, costing `dollars` at the point. */
const estimateLine = (
	model: string,
	role: "target" | "judge",
	dollars: number,
): Estimate["lines"][number] => ({
	model,
	role,
	calls: 1,
	inputTokens: 100,
	inputTokensLow: 90,
	inputTokensHigh: 120,
	outputTokens: 10,
	outputTokensLow: 5,
	outputTokensHigh: 13,
	dollars,
	dollarsLow: dollars / 2,
	dollarsHigh: dollars * 2,
	pricedAs: model,
	approximate: false,
	priced: true,
});

const estimateOf = (lines: Estimate["lines"]): Estimate => ({
	lines,
	cases: 1,
	rubricCases: 0,
	totalDollars: 0,
	totalDollarsLow: 0,
	totalDollarsHigh: 0,
	pricesUpdated: "2026-09-15",
	notes: [],
});

describe("buildReport, as a person reads the report", () => {
	test("a report holding every stability, a disagreement and a baseline diff reads back unchanged as a baseline", () => {
		const cases = [
			caseFixture("a-stable", "a"),
			caseFixture("a-flaky", "a"),
			caseFixture("a-failing", "a"),
			caseFixture("a-errored", "a"),
			caseFixture("a-partly", "a"),
			caseFixture("r-01", "r"),
		];
		const disagreeing = row({
			case: "r-01",
			model: "m",
			success: false,
			gradingResult: {
				pass: false,
				componentResults: [
					rubric(true, "ok", "google:gemini-3.5-flash"),
					rubric(false, "no", "anthropic:messages:claude-sonnet-5"),
				],
			},
		});
		const before = build(
			[
				row({ case: "a-stable", model: "m", success: false }),
				row({ case: "a-failing", model: "m" }),
				row({ case: "a-stable", model: "m2" }),
			],
			{ cases, knownCases: cases },
		);
		const report = build(
			[
				row({ case: "a-stable", model: "m" }),
				row({ case: "a-flaky", model: "m" }),
				row({ case: "a-flaky", model: "m", success: false }),
				row({ case: "a-failing", model: "m", success: false }),
				erroredRow("a-errored", "m"),
				row({ case: "a-partly", model: "m" }),
				erroredRow("a-partly", "m"),
				disagreeing,
			],
			{ cases, knownCases: cases, baseline: before },
		);
		expect(report.cases.map((caseRun) => caseRun.stability)).toEqual([
			"stable",
			"flaky",
			"failing",
			"errored",
			"partly-errored",
			"failing",
		]);
		// Only the pairs that never passed cleanly: not the stable one, not the flaky one.
		expect(report.failingPairs).toEqual([
			{ case: "a-failing", model: "m" },
			{ case: "a-errored", model: "m" },
			{ case: "a-partly", model: "m" },
			{ case: "r-01", model: "m" },
		]);
		expect(report.baseline).toEqual({
			regressions: [
				{ case: "a-failing", model: "m", before: "stable", after: "failing" },
			],
			fixed: [
				{ case: "a-stable", model: "m", before: "failing", after: "stable" },
			],
			onlyInBaseline: [{ case: "a-stable", model: "m2" }],
		});
		expect(report.disagreements).toHaveLength(1);
		const readBack = ReportSchema.parse(JSON.parse(JSON.stringify(report)));
		expect(readBack).toEqual(report);
	});

	test("a report.json whose coverage is null is refused as not a report, rather than crashing the reader", () => {
		const report = build([row({ case: "a-01", model: "m" })]);
		const parsed = ReportSchema.safeParse({
			...JSON.parse(JSON.stringify(report)),
			coverage: null,
		});
		expect(parsed.success).toBe(false);
	});

	test("a provider that threw leaves no response and no grading, and failureReason alone marks the row errored", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "Request timed out",
				failureReason: 2,
				response: undefined,
				gradingResult: undefined,
			}),
		]);
		expect(report.cases[0]?.stability).toBe("errored");
		expect(report.cases[0]?.reasons).toEqual(["Request timed out"]);
		expect(report.disagreements).toEqual([]);
	});

	test("a failed row with no grading result gives promptfoo's error as its reason", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				error: "Expected output to equal rejection",
				failureReason: 1,
				gradingResult: undefined,
			}),
		]);
		expect(report.cases[0]?.stability).toBe("failing");
		expect(report.cases[0]?.reasons).toEqual([
			"Expected output to equal rejection",
		]);
	});

	test("only the components that failed give reasons: a passing component's reason is not one", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: 1,
				error: "Expected output to equal rejection",
				gradingResult: {
					pass: false,
					componentResults: [
						{
							pass: true,
							reason: "Assertion passed",
							assertion: { type: "is-json" },
						},
						{
							pass: false,
							reason: "Expected output to equal rejection",
							assertion: { type: "equals" },
						},
					],
				},
			}),
		]);
		expect(report.cases[0]?.reasons).toEqual([
			"Expected output to equal rejection",
		]);
	});

	test("a component recorded without its assertion still gives its reason, and is never taken for a judge", () => {
		const report = build([
			row({
				case: "a-01",
				model: "m",
				success: false,
				failureReason: 1,
				gradingResult: {
					pass: false,
					componentResults: [{ pass: false, reason: "no" }],
				},
			}),
		]);
		expect(report.cases[0]?.reasons).toEqual(["no"]);
		expect(report.disagreements).toEqual([]);
		expect(report.costs.map((modelCost) => modelCost.role)).toEqual(["target"]);
	});

	test("zero matched rows quotes the first metadata.case the file carries, even after rows that carry none", () => {
		expect(() =>
			build([
				row({ case: "x", model: "m", metadata: undefined }),
				row({ case: "ghost-01", model: "m" }),
			]),
		).toThrow(
			'no result matches a case in .forge/cases (first metadata.case seen: "ghost-01", 2 rows)',
		);
	});

	test("scenario stats count passed, failed and errored runs apart", () => {
		const report = build([
			row({ case: "a-01", model: "m" }),
			row({ case: "a-02", model: "m", success: false }),
			erroredRow("a-01", "m"),
		]);
		expect(report.scenarios.find((stat) => stat.scenario === "a")).toEqual({
			scenario: "a",
			kind: "happy",
			run: 3,
			passed: 1,
			failed: 1,
			errored: 1,
		});
	});

	test("a model that is both a target and a judge compares each role with its own estimate line", () => {
		const report = build(
			[
				row({
					case: "r-01",
					model: "anthropic/claude-haiku-4-5",
					cost: 0.001,
					tokenUsage: { prompt: 400, completion: 80, total: 480 },
					gradingResult: {
						pass: true,
						componentResults: [
							{
								...rubric(true, "ok", "anthropic:messages:claude-haiku-4-5"),
								tokensUsed: { prompt: 300, completion: 60 },
							},
						],
					},
				}),
			],
			{
				estimate: estimateOf([
					estimateLine("anthropic/claude-haiku-4-5", "target", 0.0005),
					estimateLine("anthropic/claude-haiku-4-5", "judge", 0.0002),
				]),
			},
		);
		expect(
			report.costs.map((modelCost) => [
				modelCost.role,
				modelCost.estimatedDollars,
			]),
		).toEqual([
			["target", 0.0005],
			["judge", 0.0002],
		]);
	});

	test("a target that reported no usage gets no error percent against its estimate, not -100%", () => {
		const report = build([row({ case: "a-01", model: "m", cost: 0 })], {
			estimate: estimateOf([estimateLine("m", "target", 0.0005)]),
		});
		expect(report.targetUsageReported).toBe(false);
		expect(report.costs[0]?.realDollars).toBeNull();
		expect(report.costs[0]?.estimatedDollars).toBe(0.0005);
		expect(report.costs[0]?.errorPercent).toBeNull();
	});

	test("target costs are listed by model name whatever order the rows came in, each with its own tokens and rate", () => {
		const report = build([
			row({
				case: "a-01",
				model: "google/gemini-3.5-flash",
				cost: 0,
				tokenUsage: { prompt: 1000, completion: 200, total: 1200 },
			}),
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-4-5",
				cost: 0,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(
			report.costs.map((modelCost) => [
				modelCost.model,
				modelCost.inputTokens,
				modelCost.outputTokens,
				modelCost.realDollars,
			]),
		).toEqual([
			["anthropic/claude-haiku-4-5", 400, 80, (400 * 1 + 80 * 5) / 1e6],
			["google/gemini-3.5-flash", 1000, 200, (1000 * 0.3 + 200 * 2.5) / 1e6],
		]);
	});

	test("an errored row that reported no cost neither hides the target's reported cost nor its usage", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-4-5",
				cost: 0.002,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
			{
				...erroredRow("a-02", "anthropic/claude-haiku-4-5"),
				cost: 0,
				tokenUsage: undefined,
			},
		]);
		expect(report.targetUsageReported).toBe(true);
		expect(report.costs[0]?.realDollars).toBe(0.002);
	});

	test("a target that reports only a cost, with no token counts, still counts as reporting usage", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-4-5",
				cost: 0.001,
				tokenUsage: undefined,
			}),
		]);
		expect(report.targetUsageReported).toBe(true);
		expect(report.costs[0]?.realDollars).toBe(0.001);
	});

	test("a target priced from the closest listed model is marked approximate", () => {
		const report = build([
			row({
				case: "a-01",
				model: "anthropic/claude-haiku-9",
				cost: 0,
				tokenUsage: { prompt: 400, completion: 80, total: 480 },
			}),
		]);
		expect(report.costs[0]?.realDollars).toBe((400 * 1 + 80 * 5) / 1e6);
		expect(report.costs[0]?.approximatePrice).toBe(true);
	});

	test("a judge priced from the closest listed model is marked approximate", () => {
		const report = build([
			row({
				case: "r-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [
						{
							...rubric(true, "ok", "anthropic:messages:claude-haiku-9"),
							tokensUsed: { prompt: 300, completion: 60 },
						},
					],
				},
			}),
		]);
		const judge = report.costs.find((modelCost) => modelCost.role === "judge");
		expect(judge?.model).toBe("anthropic/claude-haiku-9");
		expect(judge?.realDollars).toBe((300 * 1 + 60 * 5) / 1e6);
		expect(judge?.approximatePrice).toBe(true);
	});

	test("judge costs are listed by judge name, whatever order the rubric calls came in", () => {
		const judgedBy = (provider: string) =>
			row({
				case: "r-01",
				model: "m",
				gradingResult: {
					pass: true,
					componentResults: [rubric(true, "ok", provider)],
				},
			});
		const report = build([
			judgedBy("bedrock:judge"),
			judgedBy("google:gemini-3.5-flash"),
			judgedBy("anthropic:messages:claude-sonnet-5"),
		]);
		expect(
			report.costs
				.filter((modelCost) => modelCost.role === "judge")
				.map((modelCost) => modelCost.model),
		).toEqual([
			"anthropic/claude-sonnet-5",
			"bedrock:judge",
			"google/gemini-3.5-flash",
		]);
	});

	test("a pair that stays unstable, or moves between unstable states, is neither a regression nor a fix", () => {
		const before = build([
			row({ case: "a-01", model: "m", success: false }),
			row({ case: "a-02", model: "m", success: false }),
		]);
		const report = build(
			[
				row({ case: "a-01", model: "m", success: false }),
				row({ case: "a-02", model: "m" }),
				row({ case: "a-02", model: "m", success: false }),
			],
			{ baseline: before },
		);
		expect(report.cases.map((caseRun) => caseRun.stability)).toEqual([
			"failing",
			"flaky",
		]);
		expect(report.baseline).toEqual({
			regressions: [],
			fixed: [],
			onlyInBaseline: [],
		});
	});
});

describe("isoDay", () => {
	test("a date with no time is its own day", () => {
		expect(isoDay("2026-09-16")).toBe("2026-09-16");
	});

	test("a five-digit year is not read as the four-digit year inside it", () => {
		// Date.parse takes "12026-09-16" as the year 12026.
		expect(isoDay("12026-09-16")).toBeNull();
	});
});
