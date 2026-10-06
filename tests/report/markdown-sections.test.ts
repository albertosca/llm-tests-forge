import { describe, expect, test } from "bun:test";
import type { Report } from "../../src/core/report";
import { renderReportMarkdown } from "../../src/report/markdown";

/**
 * Each section of the report is read as the exact lines a person sees, from
 * its heading to the line before the next heading, blank lines included: a
 * section that loses its trailing blank line runs into the next one, and a
 * `toContain` on one line never notices.
 */
const lines = (report: Report): string[] =>
	renderReportMarkdown(report).split("\n");

const section = (report: Report, heading: string): string[] => {
	const markdown = lines(report);
	const start = markdown.indexOf(heading);
	if (start === -1) throw new Error(`no section ${heading}`);
	const end = markdown.findIndex(
		(line, index) => index > start && line.startsWith("## "),
	);
	return markdown.slice(start, end === -1 ? undefined : end);
};

/** Everything above the first section heading. */
const top = (report: Report): string[] => {
	const markdown = lines(report);
	return markdown.slice(
		0,
		markdown.findIndex((line) => line.startsWith("## ")),
	);
};

/** A report with nothing in it: every section is at its empty wording. */
const EMPTY: Report = {
	generatedAt: "2026-09-15T20:00:00.000Z",
	ranAt: "2026-09-15T19:07:12.028Z",
	promptfooVersion: "0.123.0",
	rows: 0,
	matched: 0,
	unmatched: [],
	passRate: 0,
	cases: [],
	failing: [],
	failingPairs: [],
	flaky: [],
	scenarios: [],
	coverage: {
		reviewedScenarios: 0,
		withRuns: 0,
		withoutCase: [],
		withoutRun: [],
		notSelected: [],
	},
	disagreements: [],
	costs: [],
	targetUsageReported: true,
	baseline: null,
};

const caseRun = (
	overrides: Partial<Report["cases"][number]>,
): Report["cases"][number] => ({
	case: "c-01",
	scenario: "c",
	model: "m",
	runs: 2,
	passed: 1,
	failed: 1,
	errored: 0,
	stability: "flaky",
	reasons: [],
	...overrides,
});

const targetCost = (
	overrides: Partial<Report["costs"][number]>,
): Report["costs"][number] => ({
	model: "p/m",
	role: "target",
	inputTokens: 400,
	outputTokens: 80,
	realDollars: 0.0005,
	estimatedDollars: 0.0005,
	estimatedLowDollars: 0.0003,
	estimatedHighDollars: 0.0008,
	errorPercent: 0,
	approximatePrice: false,
	...overrides,
});

describe("the report's layout, line by line", () => {
	test("an empty report is a header, the headline and every section at its empty wording", () => {
		expect(lines(EMPTY)).toStrictEqual([
			"# llm-tests-forge report — run 2026-09-15T19:07:12.028Z",
			"Reported 2026-09-15T20:00:00.000Z.",
			"",
			"**Pass rate:** 0.0% (0 of 0 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 0",
			"",
			"## Failing or errored cases",
			"",
			"No failing or errored case.",
			"",
			"## Flaky cases",
			"",
			"No flaky case.",
			"",
			"## Judge disagreement",
			"",
			"No disagreement.",
			"",
			"## Per scenario",
			"",
			"| scenario | kind | runs | passed | failed | errored |",
			"| --- | --- | --- | --- | --- | --- |",
			"",
			"Coverage: 0 of 0 reviewed scenarios ran.",
			"",
			"## Cost",
			"",
			"| model | role | input | output | real | estimated | error |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"",
			"Target usage: reported by the shim.",
			"",
		]);
	});

	test("without a baseline nothing sits between the headline and the first section", () => {
		expect(top(EMPTY)).toStrictEqual([
			"# llm-tests-forge report — run 2026-09-15T19:07:12.028Z",
			"Reported 2026-09-15T20:00:00.000Z.",
			"",
			"**Pass rate:** 0.0% (0 of 0 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 0",
			"",
		]);
	});

	test("the regressions section: a table, the fixed count, and the pairs not compared, each followed by a blank line", () => {
		const report: Report = {
			...EMPTY,
			baseline: {
				regressions: [
					{ case: "a-01", model: "m", before: "stable", after: "failing" },
				],
				fixed: [
					{ case: "b-01", model: "m", before: "failing", after: "stable" },
					{ case: "b-02", model: "m", before: "flaky", after: "stable" },
				],
				onlyInBaseline: [{ case: "old-01", model: "m" }],
			},
		};
		expect(section(report, "## Regressions since baseline")).toStrictEqual([
			"## Regressions since baseline",
			"",
			"| case | model | before | after |",
			"| --- | --- | --- | --- |",
			"| a-01 | m | stable | failing |",
			"",
			"Fixed since baseline: 2.",
			"",
			"Not in this run, so not compared: 1 baseline pair(s) — old-01 @ m.",
			"",
		]);
	});

	test("the regressions section without a regression or an unmatched pair is three lines and a blank", () => {
		const report: Report = {
			...EMPTY,
			baseline: { regressions: [], fixed: [], onlyInBaseline: [] },
		};
		expect(section(report, "## Regressions since baseline")).toStrictEqual([
			"## Regressions since baseline",
			"",
			"No regression since baseline.",
			"",
			"Fixed since baseline: 0.",
			"",
		]);
	});

	test("the failing table has its rule row, and several reasons are joined by a semicolon and a space", () => {
		const report: Report = {
			...EMPTY,
			cases: [
				caseRun({
					case: "a-03",
					passed: 0,
					failed: 2,
					stability: "failing",
					reasons: ["first reason", "second reason"],
				}),
			],
			failing: ["a-03 @ m"],
			failingPairs: [{ case: "a-03", model: "m" }],
		};
		expect(section(report, "## Failing or errored cases")).toStrictEqual([
			"## Failing or errored cases",
			"",
			"| case | model | runs | passed | failed | errored | reasons |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"| a-03 | m | 2 | 0 | 2 | 0 | first reason; second reason |",
			"",
		]);
	});

	test("the flaky table has the same columns as the failing one", () => {
		const report: Report = {
			...EMPTY,
			cases: [caseRun({ reasons: ["x"] })],
			flaky: ["c-01 @ m"],
		};
		expect(section(report, "## Flaky cases")).toStrictEqual([
			"## Flaky cases",
			"",
			"| case | model | runs | passed | failed | errored | reasons |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"| c-01 | m | 2 | 1 | 1 | 0 | x |",
			"",
		]);
	});

	test("the disagreement table ends in a blank line, and a short row is padded", () => {
		const report: Report = {
			...EMPTY,
			disagreements: [
				{
					case: "r-01",
					model: "m",
					occurrences: 2,
					judges: [
						{ judge: "j1", pass: true, reason: "ok" },
						{ judge: "j2", pass: false, reason: "no" },
					],
				},
				{
					case: "r-02",
					model: "m",
					occurrences: 1,
					judges: [{ judge: "j1", pass: false, reason: "bad" }],
				},
			],
		};
		expect(section(report, "## Judge disagreement")).toStrictEqual([
			"## Judge disagreement",
			"",
			"| case | model | disagreeing runs | judge 1 | judge 2 |",
			"| --- | --- | --- | --- | --- |",
			"| r-01 | m | 2 | j1: pass — ok | j2: fail — no |",
			"| r-02 | m | 1 | j1: fail — bad |  |",
			"",
		]);
	});

	test("the per scenario section: a table, a blank line, the coverage sentence, a blank line", () => {
		const report: Report = {
			...EMPTY,
			scenarios: [
				{
					scenario: "a",
					kind: "happy",
					run: 6,
					passed: 3,
					failed: 2,
					errored: 1,
				},
			],
			coverage: {
				reviewedScenarios: 5,
				withRuns: 1,
				withoutCase: [],
				withoutRun: [],
				notSelected: [],
			},
		};
		expect(section(report, "## Per scenario")).toStrictEqual([
			"## Per scenario",
			"",
			"| scenario | kind | runs | passed | failed | errored |",
			"| --- | --- | --- | --- | --- | --- |",
			"| a | happy | 6 | 3 | 2 | 1 |",
			"",
			"Coverage: 1 of 5 reviewed scenarios ran.",
			"",
		]);
	});

	test("every bucket of the coverage sentence lists all its scenarios, separated by a comma and a space", () => {
		const report: Report = {
			...EMPTY,
			coverage: {
				reviewedScenarios: 9,
				withRuns: 3,
				withoutCase: ["n1", "n2"],
				withoutRun: ["s1", "s2"],
				notSelected: ["r1", "r2"],
			},
		};
		expect(section(report, "## Per scenario").at(-2)).toBe(
			"Coverage: 3 of 9 reviewed scenarios ran; no case yet: n1, n2; no matched run: s1, s2; not in this suite: r1, r2",
		);
	});

	test("with two target models the per model section is a table and a blank line; with one it is absent", () => {
		const twoTargets: Report = {
			...EMPTY,
			cases: [caseRun({}), caseRun({ model: "m2", stability: "stable" })],
			costs: [targetCost({ model: "p/m" }), targetCost({ model: "p/m2" })],
		};
		expect(section(twoTargets, "## Per model")).toStrictEqual([
			"## Per model",
			"",
			"| case | m | m2 |",
			"| --- | --- | --- |",
			"| c-01 | flaky | stable |",
			"",
		]);
		const oneTarget: Report = { ...twoTargets, costs: [targetCost({})] };
		expect(lines(oneTarget)).not.toContain("## Per model");
		expect(
			section(oneTarget, "## Per scenario").some(
				(line) =>
					line !== "" &&
					!line.startsWith("|") &&
					!line.startsWith("Coverage") &&
					!line.startsWith("##"),
			),
		).toBe(false);
	});

	test("a judge in the costs does not make a second target model", () => {
		const report: Report = {
			...EMPTY,
			cases: [caseRun({})],
			costs: [targetCost({}), targetCost({ model: "p/j", role: "judge" })],
		};
		expect(lines(report)).not.toContain("## Per model");
	});

	test("the cost section: table, a blank line, the legend and a blank line, the usage line and a blank line", () => {
		const report: Report = {
			...EMPTY,
			costs: [targetCost({ approximatePrice: true })],
		};
		expect(section(report, "## Cost")).toStrictEqual([
			"## Cost",
			"",
			"| model | role | input | output | real | estimated | error |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			"| p/m ~ | target | 400 | 80 | $0.000500 | $0.000300–$0.000800 | within range |",
			"",
			"~ marks a model priced as the closest listed model in prices.yaml.",
			"",
			"Target usage: reported by the shim.",
			"",
		]);
	});

	test("without a legend the usage line follows the table's blank line, and a shim that reported nothing says what to return", () => {
		const report: Report = {
			...EMPTY,
			targetUsageReported: false,
			costs: [targetCost({})],
		};
		expect(section(report, "## Cost").slice(-3)).toStrictEqual([
			"",
			"Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table",
			"",
		]);
		expect(section(report, "## Cost")).toHaveLength(8);
	});

	test("the unmatched rows come last, one bullet each, and the report ends in a blank line either way", () => {
		const withRows: Report = { ...EMPTY, unmatched: ["row 1", "row | 2"] };
		expect(section(withRows, "## Unmatched rows")).toStrictEqual([
			"## Unmatched rows",
			"",
			"- row 1",
			"- row \\| 2",
			"",
		]);
		expect(lines(EMPTY).at(-1)).toBe("");
		expect(lines(EMPTY).at(-2)).toBe("Target usage: reported by the shim.");
	});
});

describe("the cost cells, edge by edge", () => {
	const errorOf = (figures: Partial<Report["costs"][number]>): string => {
		const row = section(
			{ ...EMPTY, costs: [targetCost(figures)] },
			"## Cost",
		)[4];
		return (row ?? "").split(" | ").at(-1)?.replace(/ \|$/, "") ?? "";
	};

	test("a report older than the range prints its signed error: plus for a gain, a plus for zero, the sign alone for a loss", () => {
		const old = {
			estimatedLowDollars: null,
			estimatedHighDollars: null,
		} as const;
		expect(errorOf({ ...old, errorPercent: 12.34 })).toBe("+12.3%");
		expect(errorOf({ ...old, errorPercent: 0 })).toBe("+0.0%");
		expect(errorOf({ ...old, errorPercent: -0.04 })).toBe("-0.0%");
		expect(errorOf({ ...old, errorPercent: -50 })).toBe("-50.0%");
		expect(errorOf({ ...old, errorPercent: null })).toBe("—");
	});

	test("tokens in only one direction are still tokens: the line is compared, not called unrecorded", () => {
		expect(
			errorOf({ inputTokens: 0, outputTokens: 80, realDollars: null }),
		).toBe("—");
		expect(
			errorOf({ inputTokens: 400, outputTokens: 0, realDollars: null }),
		).toBe("—");
		expect(errorOf({ inputTokens: 0, outputTokens: 80, realDollars: 0 })).toBe(
			"-100.0% below",
		);
		expect(errorOf({ inputTokens: 400, outputTokens: 0, realDollars: 0 })).toBe(
			"-100.0% below",
		);
	});

	test("no tokens at all and a real cost of zero or unknown is no recorded tokens", () => {
		for (const realDollars of [0, null])
			expect(errorOf({ inputTokens: 0, outputTokens: 0, realDollars })).toBe(
				"no recorded tokens",
			);
	});

	test("a share past either bound is a percentage of that bound", () => {
		expect(
			errorOf({
				realDollars: 1.25,
				estimatedLowDollars: 0.5,
				estimatedHighDollars: 1,
			}),
		).toBe("+25.0% above");
		expect(
			errorOf({
				realDollars: 0.25,
				estimatedLowDollars: 0.5,
				estimatedHighDollars: 1,
			}),
		).toBe("-50.0% below");
	});
});
