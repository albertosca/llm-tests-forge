import { priceFor } from "../llm/prices";
import type { Feature, Prices, Suite } from "./schemas";
import type { Selection } from "./select";

/** Tokens promptfoo's grading prompt adds around the output and the rubric (measured ~200 on 2026-09-15). */
export const JUDGE_PROMPT_OVERHEAD = 200;
/** Judge answer size including the reasoning some providers bill as output (measured 55–73 completion + reasoning). */
export const JUDGE_OUTPUT_TOKENS = 80;

export interface EstimateLine {
	model: string;
	role: "target" | "judge";
	calls: number;
	inputTokens: number;
	outputTokens: number;
	dollars: number;
	pricedAs: string;
	approximate: boolean;
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
		});
	}
	const notes = [
		"tokens are estimated as characters / 4; output size is a guess from output.kind",
	];
	if (promptTokens === 0)
		notes.push(
			"application prompt not counted: set feature.prompt_file to include it",
		);
	if (lines.some((l) => l.approximate))
		notes.push("~ marks a model priced as the closest listed model");
	return {
		lines,
		cases: selection.cases.length,
		rubricCases: rubricCases.length,
		totalDollars: lines.reduce((s, l) => s + l.dollars, 0),
		pricesUpdated: prices.updated,
		notes,
	};
}

export function renderEstimate(e: Estimate): string {
	const out = [
		`estimate: ${e.cases} cases, ${e.rubricCases} with a rubric; prices dated ${e.pricesUpdated}`,
	];
	for (const l of e.lines) {
		const name = `${l.model}${l.approximate ? " ~" : ""}`.padEnd(34);
		const row = `  ${l.role.padEnd(7)} ${name} ${String(l.calls).padStart(4)} calls ${String(l.inputTokens).padStart(7)} in ${String(l.outputTokens).padStart(7)} out  $${l.dollars.toFixed(6)}`;
		out.push(l.approximate ? `${row}  (priced as ${l.pricedAs})` : row);
	}
	// The dollar column starts at index 80 in every data row; "  total" is 7 characters.
	out.push(`  total${" ".repeat(73)}$${e.totalDollars.toFixed(6)}`);
	for (const n of e.notes) out.push(`note: ${n}`);
	return out.join("\n");
}
