import { describe, expect, test } from "bun:test";
import type { Report } from "../../src/core/report";
import { renderReportMarkdown } from "../../src/report/markdown";

/**
 * One report with something in every section. The renderer relates none of
 * these fields to each other — it formats what `buildReport` computed — so
 * each field here exists to pin one rendered line.
 */
const REPORT: Report = {
	generatedAt: "2026-09-15T20:00:00.000Z",
	promptfooVersion: "0.123.0",
	rows: 7,
	matched: 6,
	unmatched: ["row 6 (testIdx 3): m: ghost-01"],
	passRate: 0.5,
	cases: [
		{
			case: "a-01",
			scenario: "a",
			model: "m",
			runs: 2,
			passed: 1,
			failed: 1,
			errored: 0,
			stability: "flaky",
			reasons: ['type was "offer"'],
		},
		{
			case: "a-02",
			scenario: "a",
			model: "m",
			runs: 2,
			passed: 2,
			failed: 0,
			errored: 0,
			stability: "stable",
			reasons: [],
		},
		{
			case: "a-03",
			scenario: "a",
			model: "m",
			runs: 2,
			passed: 0,
			failed: 2,
			errored: 0,
			stability: "failing",
			reasons: ["company was inferred from the sender domain"],
		},
	],
	failing: ["a-03 @ m"],
	failingPairs: [{ case: "a-03", model: "m" }],
	flaky: ["a-01 @ m"],
	scenarios: [
		{ scenario: "a", kind: "happy", run: 6, passed: 3, failed: 3, errored: 0 },
		{
			scenario: "r",
			kind: "ambiguous",
			run: 0,
			passed: 0,
			failed: 0,
			errored: 0,
		},
	],
	coverage: {
		reviewedScenarios: 2,
		withRuns: 1,
		withoutCase: ["r"],
		withoutRun: [],
		notSelected: [],
	},
	disagreements: [
		{
			case: "r-01",
			model: "m",
			occurrences: 1,
			judges: [
				{ judge: "google/gemini-3.5-flash", pass: true, reason: "ok" },
				{ judge: "anthropic/claude-sonnet-5", pass: false, reason: "no" },
			],
		},
	],
	costs: [
		{
			model: "anthropic/claude-haiku-4-5",
			role: "target",
			inputTokens: 400,
			outputTokens: 80,
			realDollars: 0.001,
			estimatedDollars: 0.0005,
			errorPercent: 100,
			approximatePrice: false,
		},
		{
			model: "google/gemini-3.5-flash",
			role: "judge",
			inputTokens: 526,
			outputTokens: 642,
			realDollars: 0.001763,
			estimatedDollars: null,
			errorPercent: null,
			approximatePrice: true,
		},
	],
	targetUsageReported: true,
	baseline: {
		regressions: [
			{ case: "a-01", model: "m", before: "stable", after: "failing" },
		],
		fixed: [],
		onlyInBaseline: [],
	},
};

const lines = (report: Report) => renderReportMarkdown(report).split("\n");

describe("renderReportMarkdown", () => {
	test("puts the decisive numbers in the first two lines", () => {
		const markdown = lines(REPORT);
		expect(markdown[0]).toBe(
			"# llm-tests-forge report — 2026-09-15T20:00:00.000Z",
		);
		expect(markdown).toContain(
			"**Pass rate:** 50.0% (3 of 6 runs, 0 errored) · **failing or errored:** 1 · **flaky:** 1 · **judge disagreements:** 1 · **regressions since baseline:** 1",
		);
	});

	test("names every regression against the baseline", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Regressions since baseline");
		expect(markdown).toContain("| a-01 | m | stable | failing |");
		expect(markdown).toContain("Fixed since baseline: 0.");
	});

	test("lists each flaky case with its counts and its failure reasons", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Flaky cases");
		expect(markdown).toContain(
			'| a-01 | m | 2 | 1 | 1 | 0 | type was "offer" |',
		);
	});

	test("puts each judge's verdict in its own column", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Judge disagreement");
		expect(markdown).toContain(
			"| case | model | disagreeing runs | judge 1 | judge 2 |",
		);
		expect(markdown).toContain(
			"| r-01 | m | 1 | google/gemini-3.5-flash: pass — ok | anthropic/claude-sonnet-5: fail — no |",
		);
	});

	test("baseline pairs this run does not have are named after the fixed count", () => {
		const markdown = lines({
			...REPORT,
			baseline: {
				regressions: [],
				fixed: [],
				onlyInBaseline: [
					{ case: "old-01", model: "m" },
					{ case: "old-02", model: "m" },
				],
			},
		});
		expect(markdown).toContain("No regression since baseline.");
		expect(markdown).toContain("Fixed since baseline: 0.");
		expect(markdown).toContain(
			"Not in this run, so not compared: 2 baseline pair(s) — old-01 @ m, old-02 @ m.",
		);
	});

	test("a baseline with every pair present says nothing about pairs not in the run", () => {
		const markdown = lines(REPORT);
		expect(markdown.some((line) => line.startsWith("Not in this run"))).toBe(
			false,
		);
	});

	test("coverage names the scenarios with cases but no run, after the ones with no case", () => {
		const markdown = lines({
			...REPORT,
			coverage: {
				reviewedScenarios: 3,
				withRuns: 1,
				withoutCase: ["r"],
				withoutRun: ["s"],
				notSelected: [],
			},
		});
		expect(markdown).toContain(
			"Coverage: 1 of 3 reviewed scenarios ran; no case yet: r; no matched run: s",
		);
	});

	test("coverage names the scenarios the suite did not select, after the ones with no matched run", () => {
		const markdown = lines({
			...REPORT,
			coverage: {
				reviewedScenarios: 4,
				withRuns: 1,
				withoutCase: ["n"],
				withoutRun: ["s"],
				notSelected: ["r"],
			},
		});
		expect(markdown).toContain(
			"Coverage: 1 of 4 reviewed scenarios ran; no case yet: n; no matched run: s; not in this suite: r",
		);
	});

	test("counts every scenario and says which approved ones have no case", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Per scenario");
		expect(markdown).toContain("| a | happy | 6 | 3 | 3 | 0 |");
		expect(markdown).toContain("| r | ambiguous | 0 | 0 | 0 | 0 |");
		expect(markdown).toContain(
			"Coverage: 1 of 2 reviewed scenarios ran; no case yet: r",
		);
	});

	test("prints real against estimated dollars, and marks an approximated price", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Cost");
		expect(markdown).toContain(
			"| anthropic/claude-haiku-4-5 | target | 400 | 80 | $0.001000 | $0.000500 | +100.0% |",
		);
		expect(markdown).toContain(
			"| google/gemini-3.5-flash ~ | judge | 526 | 642 | $0.001763 | — | — |",
		);
		expect(markdown).toContain(
			"~ marks a model priced as the closest listed model in prices.yaml.",
		);
		expect(markdown).toContain("Target usage: reported by the shim.");
	});

	test("lists the rows that matched no case", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Unmatched rows");
		expect(markdown).toContain("- row 6 (testIdx 3): m: ghost-01");
	});

	test("without a baseline there is no regressions section and no regressions clause", () => {
		const markdown = lines({ ...REPORT, baseline: null });
		expect(markdown).toContain(
			"**Pass rate:** 50.0% (3 of 6 runs, 0 errored) · **failing or errored:** 1 · **flaky:** 1 · **judge disagreements:** 1",
		);
		expect(markdown).not.toContain("## Regressions since baseline");
	});

	test("a baseline with nothing broken says so instead of printing an empty table", () => {
		const markdown = lines({
			...REPORT,
			baseline: {
				regressions: [],
				fixed: [
					{ case: "a-01", model: "m", before: "failing", after: "stable" },
				],
				onlyInBaseline: [],
			},
		});
		expect(markdown).toContain("No regression since baseline.");
		expect(markdown).toContain("Fixed since baseline: 1.");
		expect(markdown).not.toContain("| a-01 | m | stable | failing |");
	});

	test("lists each failing or errored case above the flaky ones, with its counts and reasons", () => {
		const markdown = lines(REPORT);
		expect(markdown).toContain("## Failing or errored cases");
		expect(markdown).toContain(
			"| a-03 | m | 2 | 0 | 2 | 0 | company was inferred from the sender domain |",
		);
		expect(markdown.indexOf("## Failing or errored cases")).toBeLessThan(
			markdown.indexOf("## Flaky cases"),
		);
	});

	test("no failing or errored case says so", () => {
		const markdown = lines({
			...REPORT,
			cases: REPORT.cases.filter((caseRun) => caseRun.case !== "a-03"),
			failing: [],
			failingPairs: [],
		});
		expect(markdown).toContain("No failing or errored case.");
		expect(markdown).not.toContain(
			"| a-03 | m | 2 | 0 | 2 | 0 | company was inferred from the sender domain |",
		);
	});

	test("an errored run is named in the headline and left out of the pass rate", () => {
		const markdown = lines({
			...REPORT,
			passRate: 1,
			cases: [
				{
					case: "a-01",
					scenario: "a",
					model: "m",
					runs: 1,
					passed: 1,
					failed: 0,
					errored: 0,
					stability: "stable",
					reasons: [],
				},
				{
					case: "a-02",
					scenario: "a",
					model: "m",
					runs: 1,
					passed: 0,
					failed: 0,
					errored: 1,
					stability: "errored",
					reasons: ["overloaded"],
				},
			],
			failing: [],
			failingPairs: [],
			flaky: [],
			baseline: null,
		});
		expect(markdown).toContain(
			"**Pass rate:** 100.0% (1 of 2 runs, 1 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 1",
		);
	});

	test("a pipe and a newline in a reason stay inside their own cell", () => {
		const markdown = lines({
			...REPORT,
			cases: [
				{
					case: "a-01",
					scenario: "a",
					model: "m",
					runs: 2,
					passed: 1,
					failed: 1,
					errored: 0,
					stability: "flaky",
					reasons: ["a | b\nsecond line"],
				},
			],
			failing: [],
			failingPairs: [],
		});
		expect(markdown).toContain(
			"| a-01 | m | 2 | 1 | 1 | 0 | a \\| b<br>second line |",
		);
	});

	test("a target that reported no usage shows no dollars rather than zero", () => {
		const markdown = lines({
			...REPORT,
			targetUsageReported: false,
			costs: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					inputTokens: 0,
					outputTokens: 0,
					realDollars: null,
					estimatedDollars: 0.051836,
					errorPercent: null,
					approximatePrice: false,
				},
			],
		});
		expect(markdown).toContain(
			"| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.051836 | — |",
		);
		expect(markdown).toContain(
			"Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table",
		);
	});

	test("no flaky case says so", () => {
		const markdown = lines({
			...REPORT,
			cases: REPORT.cases.filter((caseRun) => caseRun.case !== "a-01"),
			flaky: [],
		});
		expect(markdown).toContain("No flaky case.");
		expect(markdown).not.toContain(
			'| a-01 | m | 2 | 1 | 1 | 0 | type was "offer" |',
		);
	});

	test("no disagreement says so", () => {
		const markdown = lines({ ...REPORT, disagreements: [] });
		expect(markdown).toContain("No disagreement.");
		expect(markdown).not.toContain(
			"| case | model | disagreeing runs | judge 1 | judge 2 |",
		);
	});

	test("every approved scenario having a case drops the clause about missing ones", () => {
		const markdown = lines({
			...REPORT,
			coverage: {
				reviewedScenarios: 2,
				withRuns: 2,
				withoutCase: [],
				withoutRun: [],
				notSelected: [],
			},
		});
		expect(markdown).toContain("Coverage: 2 of 2 reviewed scenarios ran.");
	});

	test("no unmatched row means no unmatched section", () => {
		const markdown = lines({ ...REPORT, unmatched: [] });
		expect(markdown).not.toContain("## Unmatched rows");
	});

	test("prices that are all exact drop the approximation legend", () => {
		const markdown = lines({
			...REPORT,
			costs: REPORT.costs.map((modelCost) => ({
				...modelCost,
				approximatePrice: false,
			})),
		});
		expect(markdown).toContain(
			"| google/gemini-3.5-flash | judge | 526 | 642 | $0.001763 | — | — |",
		);
		expect(markdown).not.toContain(
			"~ marks a model priced as the closest listed model in prices.yaml.",
		);
	});

	test("two target models get a side by side table of stability per case", () => {
		const markdown = lines({
			...REPORT,
			cases: [
				...REPORT.cases,
				{
					case: "a-01",
					scenario: "a",
					model: "m2",
					runs: 2,
					passed: 2,
					failed: 0,
					errored: 0,
					stability: "stable",
					reasons: [],
				},
			],
			costs: [
				...REPORT.costs,
				{
					model: "m2",
					role: "target",
					inputTokens: 0,
					outputTokens: 0,
					realDollars: 0,
					estimatedDollars: null,
					errorPercent: null,
					approximatePrice: true,
				},
			],
		});
		expect(markdown).toContain("## Per model");
		expect(markdown).toContain("| case | m | m2 |");
		expect(markdown).toContain("| a-01 | flaky | stable |");
		expect(markdown).toContain("| a-02 | stable | — |");
		expect(markdown).toContain("| a-03 | failing | — |");
	});

	test("a single target model gets no side by side table", () => {
		expect(lines(REPORT)).not.toContain("## Per model");
	});

	test("an error percent below the estimate keeps its sign", () => {
		const markdown = lines({
			...REPORT,
			costs: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					inputTokens: 400,
					outputTokens: 80,
					realDollars: 0.00025,
					estimatedDollars: 0.0005,
					errorPercent: -50,
					approximatePrice: false,
				},
			],
		});
		expect(markdown).toContain(
			"| anthropic/claude-haiku-4-5 | target | 400 | 80 | $0.000250 | $0.000500 | -50.0% |",
		);
	});
	test("a case whose id contains ` @ ` is listed once, in the table its stability names", () => {
		// Both rows render the same `"<case> @ <model>"` display string, so a
		// filter built from that string puts the stable one in the flaky table.
		const markdown = lines({
			...REPORT,
			cases: [
				{
					case: "a @ m",
					scenario: "a",
					model: "m2",
					runs: 2,
					passed: 1,
					failed: 1,
					errored: 0,
					stability: "flaky",
					reasons: ["unstable"],
				},
				{
					case: "a",
					scenario: "a",
					model: "m @ m2",
					runs: 2,
					passed: 2,
					failed: 0,
					errored: 0,
					stability: "stable",
					reasons: [],
				},
			],
			failing: [],
			failingPairs: [],
			flaky: ["a @ m @ m2"],
		});
		expect(
			markdown.filter((line) => line.startsWith("| a @ m | m2 |")),
		).toEqual(["| a @ m | m2 | 2 | 1 | 1 | 0 | unstable |"]);
		expect(markdown).not.toContain("| a | m @ m2 | 2 | 2 | 0 | 0 |  |");
	});
	test("a partly-errored case is listed among the failing or errored ones, never among the flaky", () => {
		const markdown = lines({
			...REPORT,
			cases: [
				{
					case: "a-04",
					scenario: "a",
					model: "m",
					runs: 2,
					passed: 1,
					failed: 0,
					errored: 1,
					stability: "partly-errored",
					reasons: ["overloaded"],
				},
			],
			failing: ["a-04 @ m"],
			failingPairs: [{ case: "a-04", model: "m" }],
			flaky: [],
		});
		const listed = "| a-04 | m | 2 | 1 | 0 | 1 | overloaded |";
		expect(markdown).toContain(listed);
		expect(markdown).toContain("No flaky case.");
		expect(markdown.indexOf(listed)).toBeGreaterThan(
			markdown.indexOf("## Failing or errored cases"),
		);
		expect(markdown.indexOf(listed)).toBeLessThan(
			markdown.indexOf("## Flaky cases"),
		);
	});
	test("the disagreeing runs column counts the repeats a case disagreed on", () => {
		const markdown = lines({
			...REPORT,
			disagreements: [
				{
					case: "r-01",
					model: "m",
					occurrences: 3,
					judges: [
						{ judge: "google/gemini-3.5-flash", pass: true, reason: "ok" },
						{ judge: "anthropic/claude-sonnet-5", pass: false, reason: "no" },
					],
				},
			],
		});
		expect(markdown).toContain(
			"| r-01 | m | 3 | google/gemini-3.5-flash: pass — ok | anthropic/claude-sonnet-5: fail — no |",
		);
	});
	test("a row with fewer judges than the widest is padded to the same width", () => {
		const markdown = lines({
			...REPORT,
			disagreements: [
				{
					case: "r-01",
					model: "m",
					occurrences: 1,
					judges: [
						{ judge: "one", pass: true, reason: "ok" },
						{ judge: "two", pass: false, reason: "no" },
						{ judge: "three", pass: true, reason: "fine" },
					],
				},
				{
					case: "r-02",
					model: "m",
					occurrences: 1,
					judges: [
						{ judge: "one", pass: true, reason: "ok" },
						{ judge: "two", pass: false, reason: "no" },
					],
				},
			],
		});
		expect(markdown).toContain(
			"| case | model | disagreeing runs | judge 1 | judge 2 | judge 3 |",
		);
		expect(markdown).toContain(
			"| r-01 | m | 1 | one: pass — ok | two: fail — no | three: pass — fine |",
		);
		// the third cell is empty, not missing: a short row would shift the
		// pipe count and break the table for every row after it
		expect(markdown).toContain(
			"| r-02 | m | 1 | one: pass — ok | two: fail — no |  |",
		);
	});
});
