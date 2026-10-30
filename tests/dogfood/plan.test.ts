import { describe, expect, test } from "bun:test";
import {
	evalRan,
	regressionsIn,
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

describe("regressionsIn", () => {
	test("counts the regressions against the baseline", () => {
		const report = JSON.stringify({ baseline: { regressions: [{}, {}] } });
		expect(regressionsIn(report)).toBe(2);
	});
	test("a report with no baseline comparison has none", () => {
		expect(regressionsIn(JSON.stringify({}))).toBe(0);
		expect(regressionsIn(JSON.stringify({ baseline: {} }))).toBe(0);
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
