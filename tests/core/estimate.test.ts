import { describe, expect, test } from "bun:test";
import {
	approxTokens,
	estimateSuite,
	guessOutputTokens,
	JUDGE_OUTPUT_TOKENS,
	JUDGE_PROMPT_OVERHEAD,
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
const sc = (id: string, oracle: Scenario["oracle"]): Scenario => ({
	id,
	kind: "happy",
	oracle,
	description: id,
	status: "approved",
});
const cs = (
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
});

describe("estimateSuite", () => {
	test("one target, two label cases, repeat 2: calls, tokens and dollars are exact", () => {
		const selection: Selection = {
			scenarios: [sc("a", "label")],
			cases: [
				cs("a-01", "a", "x".repeat(400), { label: "rejection" }),
				cs("a-02", "a", "y".repeat(40), { label: "rejection" }),
			],
			blockers: [],
			reviewable: 0,
		};
		const e = estimateSuite({
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
		expect(e.cases).toBe(2);
		expect(e.rubricCases).toBe(0);
		expect(e.lines).toEqual([
			{
				model: "anthropic/claude-haiku-4-5",
				role: "target",
				calls: 4,
				inputTokens: (100 + 10) * 2,
				outputTokens: 4 * 8,
				dollars: (220 * 1 + 32 * 5) / 1_000_000,
				pricedAs: "anthropic/claude-haiku-4-5",
				approximate: false,
			},
		]);
		expect(e.totalDollars).toBe((220 * 1 + 32 * 5) / 1_000_000);
		expect(e.pricesUpdated).toBe("2026-09-15");
		expect(e.notes).toEqual([
			"tokens are estimated as characters / 4; output size is a guess from output.kind",
			"application prompt not counted: set feature.prompt_file to include it",
		]);
	});
	test("promptTokens are added to every target call and the prompt note disappears", () => {
		const selection: Selection = {
			scenarios: [sc("a", "label")],
			cases: [cs("a-01", "a", "x".repeat(40), { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		const e = estimateSuite({
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
		expect(e.lines[0]?.inputTokens).toBe(510);
		expect(e.notes).toEqual([
			"tokens are estimated as characters / 4; output size is a guess from output.kind",
		]);
	});
	test("judges are charged only for rubric cases, once per judge per target model per repeat", () => {
		const selection: Selection = {
			scenarios: [sc("a", "label"), sc("r", "rubric")],
			cases: [
				cs("a-01", "a", "x".repeat(40), { label: "rejection" }),
				cs("r-01", "r", "y".repeat(40), { rubric: "z".repeat(80) }),
			],
			blockers: [],
			reviewable: 0,
		};
		const e = estimateSuite({
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
		expect(e.rubricCases).toBe(1);
		const judge = e.lines.find((l) => l.role === "judge");
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
		});
		expect(e.lines.map((l) => `${l.role}:${l.model}`)).toEqual([
			"target:anthropic/claude-haiku-4-5",
			"target:anthropic/claude-sonnet-5",
			"judge:google/gemini-3.5-flash",
		]);
	});
	test("an unlisted model is marked approximate and the note says what ~ means", () => {
		const selection: Selection = {
			scenarios: [sc("a", "label")],
			cases: [cs("a-01", "a", "x", { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		const e = estimateSuite({
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
		expect(e.lines[0]?.approximate).toBe(true);
		expect(e.lines[0]?.pricedAs).toBe("anthropic/claude-haiku-4-5");
		expect(e.notes).toContain(
			"~ marks a model priced as the closest listed model",
		);
	});
	test("a suite with zero selected cases estimates zero and says so, rather than throwing", () => {
		const e = estimateSuite({
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
		expect(e.cases).toBe(0);
		expect(e.totalDollars).toBe(0);
		expect(e.lines[0]?.calls).toBe(0);
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
});
