import { describe, expect, test } from "bun:test";
import {
	describeUsage,
	evalRan,
	minimumPassRateOf,
	problemsIn,
	selectFeatures,
	summariseUsage,
} from "../../scripts/dogfood/plan";

describe("selectFeatures", () => {
	const available = ["cases", "dedupe", "describe", "scenarios"];
	test("no request runs every feature, in a fixed order", () => {
		expect(selectFeatures(["scenarios", "cases"], [])).toEqual([
			"cases",
			"scenarios",
		]);
		expect(selectFeatures(available, [])).toEqual(available);
	});
	test("a request keeps only the named features", () => {
		expect(selectFeatures(available, ["dedupe"])).toEqual(["dedupe"]);
	});
	test("a request keeps the fixed order whatever order it names them in", () => {
		expect(selectFeatures(available, ["describe", "cases"])).toEqual([
			"cases",
			"describe",
		]);
	});
	test("an unknown verb is refused with the list of known ones", () => {
		expect(() => selectFeatures(available, ["nope"])).toThrow(
			'unknown dogfood feature "nope"; known: cases, dedupe, describe, scenarios',
		);
	});
});

describe("problemsIn", () => {
	test("a run with no baseline findings and a passing rate is clean", () => {
		expect(problemsIn(JSON.stringify({ passRate: 1 }), 0.8)).toEqual([]);
		expect(
			problemsIn(JSON.stringify({ passRate: 1, baseline: {} }), 0.8),
		).toEqual([]);
	});
	test("counts the regressions against the baseline", () => {
		const report = JSON.stringify({
			passRate: 1,
			baseline: { regressions: [{}, {}] },
		});
		expect(problemsIn(report, 0.8)).toEqual(["2 regressions"]);
	});
	test("a baseline pair missing from the run is a problem, so deleting a case cannot turn the run green", () => {
		const report = JSON.stringify({
			passRate: 1,
			baseline: { onlyInBaseline: [{}] },
		});
		expect(problemsIn(report, 0.8)).toEqual([
			"1 baseline pairs are missing from this run",
		]);
	});
	test("a pass rate under the minimum fails even with nothing regressed, and the minimum itself passes", () => {
		expect(problemsIn(JSON.stringify({ passRate: 0.79 }), 0.8)).toEqual([
			"pass rate 0.79 is under the suite's minimum 0.8",
		]);
		expect(problemsIn(JSON.stringify({ passRate: 0.8 }), 0.8)).toEqual([]);
	});
	test("a report with no pass rate is refused, not read as clean", () => {
		for (const report of [{}, { passRate: "1" }, { baseline: {} }])
			expect(() => problemsIn(JSON.stringify(report), 0.8)).toThrow("passRate");
	});
	test("reports every problem at once", () => {
		const report = JSON.stringify({
			passRate: 0.5,
			baseline: { regressions: [{}], onlyInBaseline: [{}] },
		});
		expect(problemsIn(report, 0.8)).toHaveLength(3);
	});
});

describe("minimumPassRateOf", () => {
	test("reads stamp.minimum_pass_rate", () => {
		expect(minimumPassRateOf("stamp:\n  minimum_pass_rate: 0.8\n")).toBe(0.8);
	});
	test("refuses a suite that declares none", () => {
		for (const text of ["stamp: {}\n", "other: 1\n", ""])
			expect(() => minimumPassRateOf(text)).toThrow("minimum_pass_rate");
	});
});

describe("evalRan", () => {
	test("a clean exit and promptfoo's failed-rows exit both count as a run", () => {
		expect(evalRan(0)).toBe(true);
		expect(evalRan(100)).toBe(true);
	});
	test("any other exit code is a broken step", () => {
		for (const code of [1, 2, 99, 101, 127]) expect(evalRan(code)).toBe(false);
	});
});

describe("summariseUsage", () => {
	const line = (fields: Record<string, number>) =>
		JSON.stringify({
			model: "claude-haiku-4-5",
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
			...fields,
		});
	test("adds the calls up and says what they cost at list price", () => {
		const summary = summariseUsage(
			`${line({ inputTokens: 9, outputTokens: 300, cacheReadTokens: 40000, cacheCreationTokens: 5000, costUsd: 0.016 })}\n${line({ inputTokens: 1, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 1, costUsd: 0.004 })}\n`,
		);
		expect(summary).toEqual({
			calls: 2,
			inputTokens: 10,
			outputTokens: 320,
			cacheReadTokens: 40100,
			cacheCreationTokens: 5001,
			costUsd: 0.02,
		});
	});
	test("an empty or missing log is zero calls, and a blank line is skipped", () => {
		expect(summariseUsage("").calls).toBe(0);
		expect(summariseUsage(`\n${line({ costUsd: 1 })}\n\n`).calls).toBe(1);
	});
	test("a line that is not a usage record is refused, naming its number", () => {
		expect(() => summariseUsage(`${line({})}\nnot json\n`)).toThrow(
			"usage line 2",
		);
		expect(() => summariseUsage('{"costUsd":"free"}\n')).toThrow(
			"usage line 1",
		);
	});
});

describe("describeUsage", () => {
	test("reads as one line a person can compare across runs", () => {
		expect(
			describeUsage({
				calls: 2,
				inputTokens: 10,
				outputTokens: 320,
				cacheReadTokens: 40100,
				cacheCreationTokens: 5001,
				costUsd: 0.0204,
			}),
		).toBe(
			"claude-cli: 2 calls, 10 input + 320 output tokens, 40100 cache-read + 5001 cache-write tokens, about $0.02 at list price (the subscription is not billed per token)",
		);
	});
});
