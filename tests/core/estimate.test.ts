import { describe, expect, test } from "bun:test";
import {
	approxTokens,
	estimateSuite,
	guessOutputTokens,
	JUDGE_OUTPUT_TOKENS,
	JUDGE_PROMPT_OVERHEAD,
	measuredOutputTokens,
	renderEstimate,
} from "../../src/core/estimate";
import type {
	Case,
	Feature,
	Prices,
	Scenario,
	Suite,
} from "../../src/core/schemas";
import type { Selection } from "../../src/core/select";

const feature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved",
};
const prices: Prices = {
	updated: "2026-09-15",
	unit: "usd_per_million_tokens",
	sources: [],
	models: {
		"anthropic/claude-haiku-4-5": { input: 1, output: 5 },
		"google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
	},
};
const scenarioOf = (id: string, oracle: Scenario["oracle"]): Scenario => ({
	id,
	kind: "happy",
	oracle,
	description: id,
	status: "approved",
});
const caseOf = (
	id: string,
	scenario: string,
	text: string,
	expected: Case["expected"],
): Case => ({
	id,
	scenario,
	input: { email: text },
	expected,
	status: "approved",
	generated_by: "t",
});
const suite = (models: string[], judges: string[], repeat: number): Suite => ({
	target: { kind: "promptfoo-python", entry: "forge_target.py", models },
	judges,
	repeat,
	include: [],
});

describe("approxTokens / guessOutputTokens", () => {
	test("characters over four, rounded up; empty is zero", () => {
		expect(approxTokens("")).toBe(0);
		expect(approxTokens("abcd")).toBe(1);
		expect(approxTokens("abcde")).toBe(2);
	});
	test("output guess by kind", () => {
		expect(guessOutputTokens({ kind: "label", labels: ["a"] })).toBe(8);
		expect(guessOutputTokens({ kind: "json", fields: ["a", "b", "c"] })).toBe(
			24 + 16 * 3,
		);
		expect(guessOutputTokens({ kind: "json" })).toBe(64);
		expect(guessOutputTokens({ kind: "text" })).toBe(256);
	});
	test("an empty fields array is still a json shape, not the fieldless guess", () => {
		expect(guessOutputTokens({ kind: "json", fields: [] })).toBe(24);
	});
});

describe("measuredOutputTokens", () => {
	test("mean of approxTokens over each fields case's serialised expected value, rounded up", () => {
		const cases = [
			// JSON.stringify({ a: "x".repeat(32) }) is 40 characters -> approxTokens 10.
			caseOf("a-01", "a", "irrelevant", { fields: { a: "x".repeat(32) } }),
			// JSON.stringify({ a: "x".repeat(72) }) is 80 characters -> approxTokens 20.
			caseOf("a-02", "a", "irrelevant", { fields: { a: "x".repeat(72) } }),
		];
		// A fields expected value always counts, whatever the feature's own
		// output kind is: this is the raw mean, before it is floored at the
		// kind-based guess (estimateSuite does that, not this function).
		expect(measuredOutputTokens(cases, feature)).toBe(15);
	});
	test("a label case measures the label text alone when the feature's own output is itself a label", () => {
		const cases = [caseOf("a-01", "a", "irrelevant", { label: "rejection" })];
		expect(measuredOutputTokens(cases, feature)).toBe(3);
	});
	test("a label case on a json feature is not measured: the label names one field, not the whole answer", () => {
		const jsonFeature: Feature = {
			...feature,
			output: { kind: "json", fields: ["a"] },
		};
		const cases = [caseOf("a-01", "a", "irrelevant", { label: "rejection" })];
		expect(measuredOutputTokens(cases, jsonFeature)).toBeNull();
	});
	test("a rubric expected value is not output, so it never contributes a size", () => {
		const cases = [
			caseOf("r-01", "r", "irrelevant", { rubric: "z".repeat(80) }),
		];
		expect(measuredOutputTokens(cases, feature)).toBeNull();
	});
	test("a case with no expected value yet is not measured", () => {
		const cases = [caseOf("a-01", "a", "irrelevant", undefined)];
		expect(measuredOutputTokens(cases, feature)).toBeNull();
	});
	test("no cases at all: null", () => {
		expect(measuredOutputTokens([], feature)).toBeNull();
	});
	test("a mix of a rubric case and a label case measures only the label case", () => {
		const cases = [
			caseOf("r-01", "r", "irrelevant", { rubric: "z".repeat(80) }),
			caseOf("a-01", "a", "irrelevant", { label: "rejection" }),
		];
		expect(measuredOutputTokens(cases, feature)).toBe(3);
	});
});

describe("estimateSuite", () => {
	test("one target, two label cases, repeat 2: calls, tokens and dollars are exact", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [
				caseOf("a-01", "a", "x".repeat(400), { label: "rejection" }),
				caseOf("a-02", "a", "y".repeat(40), { label: "rejection" }),
			],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				2,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.cases).toBe(2);
		expect(estimate.rubricCases).toBe(0);
		// Both cases carry the label "rejection" (9 characters, approxTokens 3),
		// but the measured mean (3) is below the label guess (8), so the guess
		// wins and this behaves exactly as it did with no measuring at all.
		expect(estimate.lines).toEqual([
			{
				model: "anthropic/claude-haiku-4-5",
				role: "target",
				calls: 4,
				inputTokens: (100 + 10) * 2,
				outputTokens: 4 * 8,
				dollars: (220 * 1 + 32 * 5) / 1_000_000,
				pricedAs: "anthropic/claude-haiku-4-5",
				approximate: false,
				priced: true,
			},
		]);
		expect(estimate.totalDollars).toBe((220 * 1 + 32 * 5) / 1_000_000);
		expect(estimate.pricesUpdated).toBe("2026-09-15");
		expect(estimate.notes).toEqual([
			"tokens are estimated as characters / 4; output size is a guess from output.kind; the 2 reviewed expected values measured below it",
			"application prompt not counted: set feature.prompt_file to include it",
		]);
	});
	test("promptTokens are added to every target call and the prompt note disappears", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [caseOf("a-01", "a", "x".repeat(40), { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature,
			prices,
			promptTokens: 500,
		});
		expect(estimate.lines[0]?.inputTokens).toBe(510);
		// The one case's label ("rejection", approxTokens 3) is below the label
		// guess (8), so the guess wins and the note says the one measured value
		// fell below it.
		expect(estimate.notes).toEqual([
			"tokens are estimated as characters / 4; output size is a guess from output.kind; the 1 reviewed expected value measured below it",
		]);
	});
	test("judges are charged only for rubric cases, once per judge per target model per repeat", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label"), scenarioOf("r", "rubric")],
			cases: [
				caseOf("a-01", "a", "x".repeat(40), { label: "rejection" }),
				caseOf("r-01", "r", "y".repeat(40), { rubric: "z".repeat(80) }),
			],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5"],
				["google/gemini-3.5-flash"],
				2,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.rubricCases).toBe(1);
		const judge = estimate.lines.find((line) => line.role === "judge");
		// The only non-rubric case's label ("rejection", approxTokens 3) is
		// below the label guess (8), so the guess wins here too.
		const perCall = 8 + 20 + JUDGE_PROMPT_OVERHEAD;
		expect(judge).toEqual({
			model: "google/gemini-3.5-flash",
			role: "judge",
			calls: 1 * 2 * 2,
			inputTokens: perCall * 4,
			outputTokens: JUDGE_OUTPUT_TOKENS * 4,
			dollars: (perCall * 4 * 0.3 + JUDGE_OUTPUT_TOKENS * 4 * 2.5) / 1_000_000,
			pricedAs: "google/gemini-3.5-flash",
			approximate: false,
			priced: true,
		});
		expect(estimate.lines.map((line) => `${line.role}:${line.model}`)).toEqual([
			"target:anthropic/claude-haiku-4-5",
			"target:anthropic/claude-sonnet-5",
			"judge:google/gemini-3.5-flash",
		]);
	});
	test("an unlisted model is marked approximate and the note says what ~ means", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [caseOf("a-01", "a", "x", { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-9"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.approximate).toBe(true);
		expect(estimate.lines[0]?.pricedAs).toBe("anthropic/claude-haiku-4-5");
		expect(estimate.notes).toContain(
			"~ marks a model priced as the closest listed model",
		);
	});
	test("a model whose provider has no row at all is not priced, and the total is the priced line alone", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [caseOf("a-01", "a", "x".repeat(40), { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		// Two lines, not one: with a single unpriced line the total is zero
		// whether the filter works or not, so the test could not fail.
		const estimate = estimateSuite({
			suite: suite(
				["ollama/llama3", "anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		const unpriced = estimate.lines.find(
			(line) => line.model === "ollama/llama3",
		);
		const haiku = estimate.lines.find(
			(line) => line.model === "anthropic/claude-haiku-4-5",
		);
		expect(unpriced?.priced).toBe(false);
		expect(unpriced?.pricedAs).toBe("ollama/llama3");
		expect(unpriced?.dollars).toBe(0);
		expect(haiku?.priced).toBe(true);
		expect(haiku?.dollars).toBeGreaterThan(0);
		expect(estimate.totalDollars).toBe(haiku?.dollars ?? -1);
		expect(estimate.notes).toContain(
			"not priced: ollama/llama3 has no row in prices.yaml",
		);
	});
	test("a suite with zero selected cases estimates zero and says so, rather than throwing", () => {
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection: { scenarios: [], cases: [], blockers: [], reviewable: 0 },
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.cases).toBe(0);
		expect(estimate.totalDollars).toBe(0);
		expect(estimate.lines[0]?.calls).toBe(0);
	});
	test("a fields mean below the guess yields the guess, and the note says the reviewed values measured below it", () => {
		// guessOutputTokens({ kind: "json", fields: ["a"] }) = 24 + 16*1 = 40.
		const jsonFeature: Feature = {
			...feature,
			output: { kind: "json", fields: ["a"] },
		};
		const selection: Selection = {
			scenarios: [scenarioOf("a", "fields")],
			cases: [
				// JSON.stringify({ a: "x".repeat(32) }) is 40 chars -> approxTokens 10.
				caseOf("a-01", "a", "x".repeat(40), { fields: { a: "x".repeat(32) } }),
				// JSON.stringify({ a: "x".repeat(72) }) is 80 chars -> approxTokens 20.
				caseOf("a-02", "a", "y".repeat(40), { fields: { a: "x".repeat(72) } }),
			], // mean 15, below the guess of 40
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature: jsonFeature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(2 * 40);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is a guess from output.kind; the 2 reviewed expected values measured below it",
		);
	});
	test("a fields mean at or above the guess wins, and the note names the reviewed count", () => {
		// guessOutputTokens({ kind: "json", fields: ["a"] }) = 24 + 16*1 = 40.
		const jsonFeature: Feature = {
			...feature,
			output: { kind: "json", fields: ["a"] },
		};
		const selection: Selection = {
			scenarios: [scenarioOf("a", "fields")],
			// JSON.stringify({ a: "x".repeat(200) }) is 208 chars -> approxTokens
			// 52, above the guess of 40.
			cases: [
				caseOf("a-01", "a", "x".repeat(40), { fields: { a: "x".repeat(200) } }),
			],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature: jsonFeature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(1 * 52);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is the mean of 1 reviewed expected value",
		);
	});
	test("a label expected on a json feature is not measured, so it falls back to the guess", () => {
		// guessOutputTokens({ kind: "json", fields: ["a"] }) = 24 + 16*1 = 40.
		const jsonFeature: Feature = {
			...feature,
			output: { kind: "json", fields: ["a"] },
		};
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [caseOf("a-01", "a", "x".repeat(40), { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature: jsonFeature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(1 * 40);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is a guess from output.kind",
		);
	});
	test("a label long enough to beat the guess is still not measured on a json feature: the gate excludes it, not the floor", () => {
		// guessOutputTokens({ kind: "json", fields: ["a"] }) = 24 + 16*1 = 40.
		// The previous "not measured" test used a short label ("rejection",
		// approxTokens 3) that stays below this guess either way, so it could
		// not tell the kind gate apart from the floor alone: with no gate at
		// all, chooseOutputSize would still pick the guess over 3. This label
		// is long enough (approxTokens("x".repeat(400)) = 100) that it would
		// win as a measured mean if the gate were not there — so this test
		// only passes because the gate excludes it outright.
		const jsonFeature: Feature = {
			...feature,
			output: { kind: "json", fields: ["a"] },
		};
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			cases: [caseOf("a-01", "a", "x".repeat(40), { label: "x".repeat(400) })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature: jsonFeature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(1 * 40);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is a guess from output.kind",
		);
	});
	test("a label mean at or above the label guess wins, using the measured mean", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("a", "label")],
			// approxTokens("x".repeat(40)) = 10, at or above the label guess of 8.
			cases: [caseOf("a-01", "a", "x".repeat(40), { label: "x".repeat(40) })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(1 * 10);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is the mean of 1 reviewed expected value",
		);
	});
	test("rubric-only cases: no measurable expected value, so output size falls back to the kind-based guess", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("r", "rubric")],
			cases: [caseOf("r-01", "r", "x".repeat(40), { rubric: "z".repeat(80) })],
			blockers: [],
			reviewable: 0,
		};
		const estimate = estimateSuite({
			suite: suite(
				["anthropic/claude-haiku-4-5"],
				["google/gemini-3.5-flash"],
				1,
			),
			selection,
			feature,
			prices,
			promptTokens: 0,
		});
		expect(estimate.lines[0]?.outputTokens).toBe(1 * 8);
		expect(estimate.notes).toContain(
			"tokens are estimated as characters / 4; output size is a guess from output.kind",
		);
	});
});

describe("renderEstimate", () => {
	test("prints one row per line with ~ on approximate rows, the total, the prices date and every note", () => {
		const text = renderEstimate({
			cases: 2,
			rubricCases: 0,
			pricesUpdated: "2026-09-15",
			totalDollars: 0.0012,
			notes: ["n1", "n2"],
			lines: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0.0004,
					pricedAs: "anthropic/claude-haiku-4-5",
					approximate: false,
					priced: true,
				},
				{
					model: "google/gemini-9",
					role: "judge",
					calls: 2,
					inputTokens: 100,
					outputTokens: 10,
					dollars: 0.0008,
					pricedAs: "google/gemini-3.5-flash",
					approximate: true,
					priced: true,
				},
			],
		});
		const lines = text.split("\n");
		expect(lines).toContain(
			"estimate: 2 cases, 0 with a rubric; prices dated 2026-09-15",
		);
		expect(lines).toContain(
			"  target  anthropic/claude-haiku-4-5            4 calls     220 in      32 out  $0.000400",
		);
		expect(lines).toContain(
			"  judge   google/gemini-9 ~                     2 calls     100 in      10 out  $0.000800  (priced as google/gemini-3.5-flash)",
		);
		expect(lines).toContain(
			"  total                                                                         $0.001200",
		);
		expect(lines).toContain("note: n1");
		expect(lines).toContain("note: n2");
	});
	test("an unpriced line prints 'not priced' in the dollar column, with no ~ or (priced as ...)", () => {
		const text = renderEstimate({
			cases: 1,
			rubricCases: 0,
			pricesUpdated: "2026-09-15",
			totalDollars: 0.0004,
			notes: ["not priced: ollama/llama3 has no row in prices.yaml"],
			lines: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0.0004,
					pricedAs: "anthropic/claude-haiku-4-5",
					approximate: false,
					priced: true,
				},
				{
					model: "ollama/llama3",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0,
					pricedAs: "ollama/llama3",
					approximate: true,
					priced: false,
				},
			],
		});
		const lines = text.split("\n");
		const unpriced = lines.find((line) => line.includes("ollama/llama3"));
		expect(unpriced).toContain("not priced");
		expect(unpriced).not.toContain("$");
		expect(unpriced).not.toContain("(priced as");
		expect(unpriced).not.toContain("~");
		expect(lines).toContain(
			"note: not priced: ollama/llama3 has no row in prices.yaml",
		);
	});
	test("the total row says how many lines it left out when one of them is unpriced", () => {
		const text = renderEstimate({
			cases: 1,
			rubricCases: 0,
			pricesUpdated: "2026-09-15",
			totalDollars: 0.0004,
			notes: [],
			lines: [
				{
					model: "anthropic/claude-haiku-4-5",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0.0004,
					pricedAs: "anthropic/claude-haiku-4-5",
					approximate: false,
					priced: true,
				},
				{
					model: "ollama/llama3",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0,
					pricedAs: "ollama/llama3",
					approximate: false,
					priced: false,
				},
			],
		});
		expect(text.split("\n")).toContain(
			"  total                                                                         $0.000400  (1 line not priced)",
		);
	});
	test("with every line unpriced the total reads 'not priced', not $0.000000", () => {
		const text = renderEstimate({
			cases: 1,
			rubricCases: 0,
			pricesUpdated: "2026-09-15",
			totalDollars: 0,
			notes: [],
			lines: [
				{
					model: "ollama/llama3",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0,
					pricedAs: "ollama/llama3",
					approximate: false,
					priced: false,
				},
				{
					model: "ollama/qwen3",
					role: "target",
					calls: 4,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 0,
					pricedAs: "ollama/qwen3",
					approximate: false,
					priced: false,
				},
			],
		});
		const lines = text.split("\n");
		const totalRow = lines.find((line) => line.startsWith("  total"));
		expect(totalRow).toBe(
			"  total                                                                         not priced  (2 lines not priced)",
		);
		// The total sits in the same column as the rows it summarises, which
		// a column computed from a "$" no row carries could not do.
		const dataRow = lines.find((line) => line.includes("ollama/qwen3"));
		expect(totalRow?.indexOf("not priced")).toBe(
			dataRow?.indexOf("not priced"),
		);
	});
	test("the total's $ lines up with a data row's $ regardless of model-name width (39 chars, 120000 calls)", () => {
		const longModel = `anthropic/${"x".repeat(29)}`; // 10 + 29 = 39 chars
		expect(longModel.length).toBe(39);
		const text = renderEstimate({
			cases: 1,
			rubricCases: 0,
			pricesUpdated: "2026-09-15",
			totalDollars: 1.2,
			notes: [],
			lines: [
				{
					model: longModel,
					role: "target",
					calls: 120000,
					inputTokens: 220,
					outputTokens: 32,
					dollars: 1.2,
					pricedAs: longModel,
					approximate: false,
					priced: true,
				},
			],
		});
		const lines = text.split("\n");
		const dataRow = lines.find((line) => line.includes(longModel));
		const totalRow = lines.find((line) => line.startsWith("  total"));
		expect(dataRow).toBeDefined();
		expect(totalRow).toBeDefined();
		expect(totalRow?.indexOf("$")).toBe(dataRow?.indexOf("$"));
	});
});
