import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ForgeError } from "../../src/core/errors";
import type { Estimate } from "../../src/core/estimate";
import { readAllCases, readScenarios } from "../../src/core/files";
import { buildReport, ReportSchema } from "../../src/core/report";
import type { Case, Prices, Scenario } from "../../src/core/schemas";
import { type PromptfooResults, readResults } from "../../src/report/results";

const NOW = new Date("2026-09-15T20:00:00Z");
const FIXTURE = resolve("tests/fixtures/promptfoo-results-0.123.0.json");

const prices: Prices = {
	updated: "2026-09-15",
	unit: "usd_per_million_tokens",
	sources: [],
	models: {
		"anthropic/claude-haiku-4-5": { input: 1, output: 5 },
		"google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
	},
};

const sc = (
	id: string,
	oracle: Scenario["oracle"],
	status: Scenario["status"] = "approved",
): Scenario => ({ id, kind: "happy", oracle, description: id, status });

const cs = (
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

function row(p: Partial<Row> & { case: string; model: string }): Row {
	const { case: c, model, ...rest } = p;
	return {
		testIdx: 0,
		success: true,
		cost: 0,
		provider: { id: "file://forge_target.py", label: model },
		metadata: { case: c },
		gradingResult: { pass: rest.success ?? true, componentResults: [] },
		...rest,
	};
}

function results(rows: Row[]): PromptfooResults {
	return {
		results: { results: rows.map((r, i) => ({ ...r, testIdx: i })) },
		metadata: { promptfooVersion: "0.123.0" },
	};
}

const build = (
	rows: Row[],
	extra: Partial<Parameters<typeof buildReport>[0]> = {},
) =>
	buildReport({
		results: results(rows),
		resultsPath: "r.json",
		scenarios: [sc("a", "label"), sc("r", "rubric")],
		cases: [cs("a-01", "a"), cs("a-02", "a"), cs("r-01", "r")],
		knownCases: [cs("a-01", "a"), cs("a-02", "a"), cs("r-01", "r")],
		estimate: null,
		prices,
		baseline: null,
		now: NOW,
		...extra,
	});

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
				sc("ack-optional-quiz", "label"),
				sc("out-of-scope-newsletter", "rubric"),
			],
			cases: [
				cs("ack-optional-quiz-01", "ack-optional-quiz"),
				cs("out-of-scope-newsletter-02", "out-of-scope-newsletter"),
			],
			knownCases: [
				cs("ack-optional-quiz-01", "ack-optional-quiz"),
				cs("out-of-scope-newsletter-02", "out-of-scope-newsletter"),
			],
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
				errorPercent: null,
				approximatePrice: false,
			},
		]);
	});

	test("the committed example run: 46 of 48 rows pass, two asserts fail, nothing errored", async () => {
		const exampleForge = resolve("examples/moonlighter-classify-email/.forge");
		const report = buildReport({
			results: await readResults(
				resolve("examples/moonlighter-classify-email/results.json"),
			),
			resultsPath: "results.json",
			scenarios: await readScenarios(exampleForge),
			cases: [...(await readAllCases(exampleForge)).values()].flat(),
			knownCases: [...(await readAllCases(exampleForge)).values()].flat(),
			estimate: null,
			prices,
			baseline: null,
			now: NOW,
		});
		expect(report.rows).toBe(48);
		expect(report.matched).toBe(48);
		expect(report.passRate).toBe(0.9583);
		const failed = report.scenarios.reduce((n, s) => n + s.failed, 0);
		const errored = report.scenarios.reduce((n, s) => n + s.errored, 0);
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
			cases: [cs("a-01", "a")],
			knownCases: [cs("a-01", "a"), cs("a-02", "a", "rejected")],
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
		expect(report.cases.map((c) => [c.case, c.stability, c.reasons])).toEqual([
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
		expect(report.cases[0]?.reasons).toEqual([]);
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
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("forge emitted");
		expect((caught as ForgeError).details.file).toBe("r.json");
	});

	test("scenario stats cover every reviewed scenario in file order, and coverage names the ones with no case", () => {
		const report = build([row({ case: "a-01", model: "m" })], {
			scenarios: [
				sc("a", "label"),
				sc("r", "rubric"),
				sc("p", "label", "pending"),
			],
			cases: [cs("a-01", "a"), cs("a-02", "a"), cs("r-01", "r", "rejected")],
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
		});
	});

	test("an edited scenario and an edited case count exactly like approved ones", () => {
		const report = build(
			[row({ case: "a-01", model: "m" }), row({ case: "e-01", model: "m" })],
			{
				scenarios: [sc("a", "label"), sc("e", "label", "edited")],
				cases: [cs("a-01", "a"), cs("e-01", "e", "edited")],
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
		});
		expect(report.cases.map((c) => c.case)).toEqual(["a-01", "e-01"]);
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
		const judge = report.costs.find((c) => c.role === "judge");
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
					outputTokens: 40,
					dollars: 0.0005,
					pricedAs: "anthropic/claude-haiku-4-5",
					approximate: false,
					priced: true,
				},
			],
			cases: 1,
			rubricCases: 0,
			totalDollars: 0.0005,
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
		expect(report.costs[0]?.errorPercent).toBe(100);

		const other = build([row({ case: "a-01", model: "m", cost: 0.001 })], {
			estimate,
		});
		expect(other.costs[0]?.estimatedDollars).toBeNull();
		expect(other.costs[0]?.errorPercent).toBeNull();
	});

	test("an estimate of zero dollars gives no error percent to divide by", () => {
		const estimate: Estimate = {
			lines: [
				{
					model: "m",
					role: "target",
					calls: 0,
					inputTokens: 0,
					outputTokens: 0,
					dollars: 0,
					pricedAs: "m",
					approximate: true,
					priced: true,
				},
			],
			cases: 0,
			rubricCases: 0,
			totalDollars: 0,
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
		});
		expect(before.baseline).toBeNull();
	});

	test("cases are ordered by model name, then by the order of the cases file", () => {
		const report = build([
			row({ case: "a-02", model: "m2" }),
			row({ case: "a-01", model: "m1" }),
			row({ case: "a-02", model: "m1" }),
			row({ case: "a-01", model: "m2" }),
		]);
		expect(report.cases.map((c) => `${c.case}@${c.model}`)).toEqual([
			"a-01@m1",
			"a-02@m1",
			"a-01@m2",
			"a-02@m2",
		]);
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
		} catch (e) {
			caught = e;
		}
		expect((caught as ForgeError).message).toBe(
			'no result matches a case in .forge/cases (first metadata.case seen: "ghost-01", 2 rows); was this results.json produced from a config forge emitted? (file: r.json)',
		);
	});

	test("zero matched rows with no metadata.case anywhere says none rather than quoting an id", () => {
		let caught: unknown;
		try {
			build([
				row({ case: "x", model: "m", metadata: undefined }),
				row({ case: "y", model: "m", metadata: {} }),
			]);
		} catch (e) {
			caught = e;
		}
		expect((caught as ForgeError).message).toBe(
			"no result matches a case in .forge/cases (first metadata.case seen: none, 2 rows); was this results.json produced from a config forge emitted? (file: r.json)",
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
