import { describe, expect, test } from "bun:test";
import {
	evalRan,
	minimumPassRateOf,
	problemsIn,
	selectFeatures,
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
		expect(problemsIn(JSON.stringify({ baseline: {} }), 0.8)).toEqual([]);
	});
	test("counts the regressions against the baseline", () => {
		const report = JSON.stringify({ baseline: { regressions: [{}, {}] } });
		expect(problemsIn(report, 0.8)).toEqual(["2 regressions"]);
	});
	test("a baseline pair missing from the run is a problem, so deleting a case cannot turn the run green", () => {
		const report = JSON.stringify({ baseline: { onlyInBaseline: [{}] } });
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
