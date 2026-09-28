import { priceFor } from "../llm/prices";
import type { Case, Feature, Prices, Suite } from "./schemas";
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

/**
 * The size a single case's expected value would carry as output, or `null`
 * for a `rubric` expected value (it grades the target's answer, it is not
 * an answer itself) or a case with no `expected` yet.
 */
function measuredOutputSize(expected: Case["expected"]): number | null {
	if (expected === undefined) return null;
	if (expected.fields !== undefined)
		return approxTokens(JSON.stringify(expected.fields));
	if (expected.label !== undefined) return approxTokens(expected.label);
	return null;
}

/**
 * The mean output size actually written into the reviewed cases' expected
 * values — a `fields` case as promptfoo would serialise it back
 * (`JSON.stringify`), a `label` case as the label text itself — rounded up.
 * `null` when no selected case has a measurable expected value at all
 * (every case is rubric-only, or none carries an `expected` yet), which
 * tells the caller to fall back to the kind-based guess.
 */
export function measuredOutputTokens(cases: Case[]): number | null {
	const sizes = cases
		.map((testCase) => measuredOutputSize(testCase.expected))
		.filter((size): size is number => size !== null);
	if (sizes.length === 0) return null;
	return Math.ceil(sizes.reduce((sum, size) => sum + size, 0) / sizes.length);
}

function dollars(
	inputTokens: number,
	outputTokens: number,
	price: { input: number; output: number },
): number {
	return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function estimateSuite(parameters: {
	suite: Suite;
	selection: Selection;
	feature: Feature;
	prices: Prices;
	promptTokens: number;
}): Estimate {
	const { suite, selection, feature, prices, promptTokens } = parameters;
	const measuredOutput = measuredOutputTokens(selection.cases);
	const outputSize = measuredOutput ?? guessOutputTokens(feature.output);
	const reviewedExpectedValueCount = selection.cases.filter(
		(testCase) => measuredOutputSize(testCase.expected) !== null,
	).length;
	const scenarioOracleById = new Map(
		selection.scenarios.map((scenario) => [scenario.id, scenario.oracle]),
	);
	const caseInputTokens = selection.cases.map((testCase) =>
		approxTokens(Object.values(testCase.input).join("\n")),
	);
	const rubricCases = selection.cases.filter(
		(testCase) => scenarioOracleById.get(testCase.scenario) === "rubric",
	);
	const lines: EstimateLine[] = [];

	for (const model of suite.target.models) {
		const price = priceFor(model, prices);
		const calls = selection.cases.length * suite.repeat;
		const inputTokens =
			caseInputTokens.reduce((sum, tokens) => sum + tokens + promptTokens, 0) *
			suite.repeat;
		const outputTokens = calls * outputSize;
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
				(sum, testCase) =>
					sum +
					outputSize +
					approxTokens(testCase.expected?.rubric ?? "") +
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
	const outputSizeNote =
		measuredOutput !== null
			? `output size is the mean of ${plural(reviewedExpectedValueCount, "reviewed expected value")}`
			: "output size is a guess from output.kind";
	const notes = [`tokens are estimated as characters / 4; ${outputSizeNote}`];
	if (promptTokens === 0)
		notes.push(
			"application prompt not counted: set feature.prompt_file to include it",
		);
	if (lines.some((line) => line.priced && line.approximate))
		notes.push("~ marks a model priced as the closest listed model");
	for (const model of new Set(
		lines.filter((line) => !line.priced).map((line) => line.model),
	))
		notes.push(`not priced: ${model} has no row in prices.yaml`);
	return {
		lines,
		cases: selection.cases.length,
		rubricCases: rubricCases.length,
		totalDollars: lines
			.filter((line) => line.priced)
			.reduce((sum, line) => sum + line.dollars, 0),
		pricesUpdated: prices.updated,
		notes,
	};
}

/** What a line with no price at all prints where a dollar figure would go. */
const NOT_PRICED = "not priced";

export function renderEstimate(estimate: Estimate): string {
	const out = [
		`estimate: ${plural(estimate.cases, "case")}, ${estimate.rubricCases} with a rubric; prices dated ${estimate.pricesUpdated}`,
	];
	const rendered = estimate.lines.map((line) => {
		const marked = line.priced && line.approximate;
		const name = `${line.model}${marked ? " ~" : ""}`.padEnd(34);
		const dollarText = line.priced ? `$${line.dollars.toFixed(6)}` : NOT_PRICED;
		// The column the dollar figure starts at, taken from the prefix that
		// puts it there rather than by searching the finished row for a "$":
		// a row that says "not priced" carries no "$" at all, and a search
		// over rows where none does returned -1, which rendered the total as
		// "  total$0.000000" — the one number a person must not misread.
		const prefix = `  ${line.role.padEnd(7)} ${name} ${String(line.calls).padStart(4)} calls ${String(line.inputTokens).padStart(7)} in ${String(line.outputTokens).padStart(7)} out  `;
		const row = `${prefix}${dollarText}`;
		return {
			row: marked ? `${row}  (priced as ${line.pricedAs})` : row,
			dollarAt: prefix.length,
		};
	});
	out.push(...rendered.map((renderedLine) => renderedLine.row));
	// The dollar column sits wherever the widest data row starts its figure;
	// "  total" is 7 characters, so that many fewer spaces are needed.
	const dollarColumn = Math.max(
		0,
		...rendered.map((renderedLine) => renderedLine.dollarAt),
	);
	const label = "  total";
	const unpriced = estimate.lines.filter((line) => !line.priced).length;
	// `totalDollars` sums the priced lines, so with none of them priced the
	// sum is a true zero of nothing at all: printing "$0.000000" would read
	// as a free run. Either way the count of omitted lines is named, because
	// the total is the number a person acts on.
	const figure =
		unpriced === estimate.lines.length
			? NOT_PRICED
			: `$${estimate.totalDollars.toFixed(6)}`;
	const omitted =
		unpriced === 0 ? "" : `  (${plural(unpriced, "line")} not priced)`;
	out.push(
		`${label}${" ".repeat(Math.max(0, dollarColumn - label.length))}${figure}${omitted}`,
	);
	for (const note of estimate.notes) out.push(`note: ${note}`);
	return out.join("\n");
}
