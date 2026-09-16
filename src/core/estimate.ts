import { priceFor } from "../llm/prices";
import type { Feature, Prices, Suite } from "./schemas";
import type { Selection } from "./select";

/** Tokens promptfoo's grading prompt adds around the output and the rubric (measured ~200 on 2026-09-15). */
export const JUDGE_PROMPT_OVERHEAD = 200;
/**
 * Judge answer size including the reasoning some providers bill as output.
 * Measured as `completion + completionDetails.reasoning` over every
 * `llm-rubric` component: mean 174 across the 6 components of
 * `examples/moonlighter-classify-email/results.json` (2026-09-16), and mean
 * 321 across the 2 of `tests/fixtures/promptfoo-results-0.123.0.json` — set
 * from the larger, more representative example run. A judge that rejects
 * writes far more than one that passes: the 3 passing components above
 * measured 68–85 tokens with no reasoning at all, while the 3 rejecting
 * ones ranged 92–359, two of them paying for hidden reasoning tokens to
 * explain the rejection. A real tokenizer would replace this constant; the
 * estimate is a guess either way, calibrated rather than exact.
 */
export const JUDGE_OUTPUT_TOKENS = 174;

export interface EstimateLine {
	model: string;
	role: "target" | "judge";
	calls: number;
	inputTokens: number;
	outputTokens: number;
	dollars: number;
	pricedAs: string;
	approximate: boolean;
	/** False when the model's provider has no row at all in prices.yaml. */
	priced: boolean;
}

export interface Estimate {
	lines: EstimateLine[];
	cases: number;
	rubricCases: number;
	totalDollars: number;
	pricesUpdated: string;
	notes: string[];
}

export function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function guessOutputTokens(output: Feature["output"]): number {
	switch (output.kind) {
		case "label":
			return 8;
		case "json":
			return output.fields ? 24 + 16 * output.fields.length : 64;
		case "text":
			return 256;
	}
}

function dollars(
	inputTokens: number,
	outputTokens: number,
	price: { input: number; output: number },
): number {
	return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function estimateSuite(args: {
	suite: Suite;
	selection: Selection;
	feature: Feature;
	prices: Prices;
	promptTokens: number;
}): Estimate {
	const { suite, selection, feature, prices, promptTokens } = args;
	const outGuess = guessOutputTokens(feature.output);
	const oracleOf = new Map(selection.scenarios.map((s) => [s.id, s.oracle]));
	const caseInputs = selection.cases.map((c) =>
		approxTokens(Object.values(c.input).join("\n")),
	);
	const rubricCases = selection.cases.filter(
		(c) => oracleOf.get(c.scenario) === "rubric",
	);
	const lines: EstimateLine[] = [];

	for (const model of suite.target.models) {
		const price = priceFor(model, prices);
		const calls = selection.cases.length * suite.repeat;
		const inputTokens =
			caseInputs.reduce((sum, t) => sum + t + promptTokens, 0) * suite.repeat;
		const outputTokens = calls * outGuess;
		lines.push({
			model,
			role: "target",
			calls,
			inputTokens,
			outputTokens,
			dollars: dollars(inputTokens, outputTokens, price),
			pricedAs: price.pricedAs,
			approximate: price.approximate,
			priced: price.priced,
		});
	}
	for (const judge of rubricCases.length > 0 ? suite.judges : []) {
		const price = priceFor(judge, prices);
		const perJudgeCalls = suite.target.models.length * suite.repeat;
		const calls = rubricCases.length * perJudgeCalls;
		const inputTokens =
			rubricCases.reduce(
				(sum, c) =>
					sum +
					outGuess +
					approxTokens(c.expected?.rubric ?? "") +
					JUDGE_PROMPT_OVERHEAD,
				0,
			) * perJudgeCalls;
		const outputTokens = calls * JUDGE_OUTPUT_TOKENS;
		lines.push({
			model: judge,
			role: "judge",
			calls,
			inputTokens,
			outputTokens,
			dollars: dollars(inputTokens, outputTokens, price),
			pricedAs: price.pricedAs,
			approximate: price.approximate,
			priced: price.priced,
		});
	}
	const notes = [
		"tokens are estimated as characters / 4; output size is a guess from output.kind",
	];
	if (promptTokens === 0)
		notes.push(
			"application prompt not counted: set feature.prompt_file to include it",
		);
	if (lines.some((l) => l.priced && l.approximate))
		notes.push("~ marks a model priced as the closest listed model");
	for (const model of new Set(
		lines.filter((l) => !l.priced).map((l) => l.model),
	))
		notes.push(`not priced: ${model} has no row in prices.yaml`);
	return {
		lines,
		cases: selection.cases.length,
		rubricCases: rubricCases.length,
		totalDollars: lines
			.filter((l) => l.priced)
			.reduce((s, l) => s + l.dollars, 0),
		pricesUpdated: prices.updated,
		notes,
	};
}

export function renderEstimate(e: Estimate): string {
	const out = [
		// core has no dependency on the cli layer's plural(), so this stays a
		// local ternary rather than importing it.
		`estimate: ${e.cases} case${e.cases === 1 ? "" : "s"}, ${e.rubricCases} with a rubric; prices dated ${e.pricesUpdated}`,
	];
	const rows = e.lines.map((l) => {
		const marked = l.priced && l.approximate;
		const name = `${l.model}${marked ? " ~" : ""}`.padEnd(34);
		const dollarText = l.priced ? `$${l.dollars.toFixed(6)}` : "not priced";
		const row = `  ${l.role.padEnd(7)} ${name} ${String(l.calls).padStart(4)} calls ${String(l.inputTokens).padStart(7)} in ${String(l.outputTokens).padStart(7)} out  ${dollarText}`;
		return marked ? `${row}  (priced as ${l.pricedAs})` : row;
	});
	out.push(...rows);
	// The dollar column sits wherever the widest data row put its "$";
	// "  total" is 7 characters, so that many fewer spaces are needed.
	const dollarCol = Math.max(...rows.map((r) => r.indexOf("$")));
	const label = "  total";
	out.push(
		`${label}${" ".repeat(Math.max(0, dollarCol - label.length))}$${e.totalDollars.toFixed(6)}`,
	);
	for (const n of e.notes) out.push(`note: ${n}`);
	return out.join("\n");
}
