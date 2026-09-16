import { priceFor } from "../llm/prices";
import type { Feature, Prices, Suite } from "./schemas";
import type { Selection } from "./select";
import { plural } from "./text";

/** Tokens promptfoo's grading prompt adds around the output and the rubric (measured ~200 on 2026-09-15). */
export const JUDGE_PROMPT_OVERHEAD = 200;
/**
 * Judge answer size including the reasoning some providers bill as output,
 * measured as `completion + completionDetails.reasoning` over every
 * `llm-rubric` component of a run.
 *
 * 174 was fit to the example run of 2026-09-16 (1042 tokens over 6
 * components). The example has been re-run since, and the committed
 * `examples/moonlighter-classify-email/results.json` now measures
 * [102, 71, 69, 71, 167, 186] = 666 over the same 6 components, a mean of
 * 111; `tests/fixtures/promptfoo-results-0.123.0.json` measures 321 over
 * its 2. The constant stays at 174 on purpose: what moves it is how many
 * rubric cases the judge rejects — a rejection writes an explanation and
 * pays for hidden reasoning tokens (the 4 passing components above wrote
 * 69–102 with no reasoning at all, the 2 rejecting ones 167 and 186 with
 * 44 and 54 of it), and no constant can know that count before the run. A
 * number fit to the cheaper of two observed runs would understate the bill
 * whenever the suite starts failing, which is exactly when the estimate is
 * read. A real tokenizer would replace this constant; the estimate is a
 * guess either way, calibrated rather than exact.
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

/** What a line with no price at all prints where a dollar figure would go. */
const NOT_PRICED = "not priced";

export function renderEstimate(e: Estimate): string {
	const out = [
		`estimate: ${plural(e.cases, "case")}, ${e.rubricCases} with a rubric; prices dated ${e.pricesUpdated}`,
	];
	const rendered = e.lines.map((l) => {
		const marked = l.priced && l.approximate;
		const name = `${l.model}${marked ? " ~" : ""}`.padEnd(34);
		const dollarText = l.priced ? `$${l.dollars.toFixed(6)}` : NOT_PRICED;
		// The column the dollar figure starts at, taken from the prefix that
		// puts it there rather than by searching the finished row for a "$":
		// a row that says "not priced" carries no "$" at all, and a search
		// over rows where none does returned -1, which rendered the total as
		// "  total$0.000000" — the one number a person must not misread.
		const prefix = `  ${l.role.padEnd(7)} ${name} ${String(l.calls).padStart(4)} calls ${String(l.inputTokens).padStart(7)} in ${String(l.outputTokens).padStart(7)} out  `;
		const row = `${prefix}${dollarText}`;
		return {
			row: marked ? `${row}  (priced as ${l.pricedAs})` : row,
			dollarAt: prefix.length,
		};
	});
	out.push(...rendered.map((r) => r.row));
	// The dollar column sits wherever the widest data row starts its figure;
	// "  total" is 7 characters, so that many fewer spaces are needed.
	const dollarCol = Math.max(0, ...rendered.map((r) => r.dollarAt));
	const label = "  total";
	const unpriced = e.lines.filter((l) => !l.priced).length;
	// `totalDollars` sums the priced lines, so with none of them priced the
	// sum is a true zero of nothing at all: printing "$0.000000" would read
	// as a free run. Either way the count of omitted lines is named, because
	// the total is the number a person acts on.
	const figure =
		unpriced === e.lines.length ? NOT_PRICED : `$${e.totalDollars.toFixed(6)}`;
	const omitted =
		unpriced === 0 ? "" : `  (${plural(unpriced, "line")} not priced)`;
	out.push(
		`${label}${" ".repeat(Math.max(0, dollarCol - label.length))}${figure}${omitted}`,
	);
	for (const n of e.notes) out.push(`note: ${n}`);
	return out.join("\n");
}
