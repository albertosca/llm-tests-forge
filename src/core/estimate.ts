import { priceFor } from "../llm/prices";
import type { Case, Feature, Prices, Suite } from "./schemas";
import type { Selection } from "./select";
import { plural } from "./text";

/**
 * Characters per token, the point value `approxTokens` divides by. The
 * range below is what the recorded runs actually measured around it.
 */
const CHARACTERS_PER_TOKEN = 4;
/**
 * The characters-per-token band real target prompts fell in. Fit on
 * 2026-09-29 to the 48 target rows of the classify-email run
 * (`tests/fixtures/classify-email/results.json`, Claude Haiku 4.5), whose
 * `prompt.txt` plus joined case input measured 3.54 to 4.17 characters per
 * recorded prompt token. A lower ratio means more tokens, so `_LOW` gives
 * the high token count and `_HIGH` the low one. extract-questions records
 * 0 target tokens, so it fits nothing. A later run with recorded target
 * usage, the three-input classify-email rerun of 2026-09-30
 * (`tests/fixtures/classify-email-three-inputs/`), did not shape the band
 * and measured 3.50 to 4.15: inside it, its lowest row on the edge.
 */
export const INPUT_CHARACTERS_PER_TOKEN_LOW = 3.5;
export const INPUT_CHARACTERS_PER_TOKEN_HIGH = 4.2;
/**
 * The band around the target's output size, which is estimated from the
 * feature's output kind (or the reviewed expected values) with no text of
 * the real answer to count. Declared, not fit: the owner set 0.5× to 1.25×
 * on 2026-09-29. For scale, classify-email's real output averaged 94 tokens
 * per call against a guess of 120 (0.79×).
 */
export const OUTPUT_GUESS_LOW_FACTOR = 0.5;
export const OUTPUT_GUESS_HIGH_FACTOR = 1.25;
/**
 * Tokens promptfoo's grading prompt adds around the graded answer and the
 * rubric, measured on 2026-09-29 as a rubric component's prompt tokens
 * minus the answer and the rubric counted as characters/4, over the 26
 * components of the three frozen runs: Anthropic (classify-email,
 * extract-questions) 275 to 372, Google (`promptfoo-results-0.123.0.json`)
 * 172 to 175. The point value is the plan's measured Anthropic midpoint,
 * 300; on these components the Anthropic per-run means are 286.5
 * (classify-email) and 330.6 (extract-questions). The band covers both
 * providers.
 */
export const JUDGE_PROMPT_OVERHEAD = 300;
export const JUDGE_PROMPT_OVERHEAD_LOW = 170;
export const JUDGE_PROMPT_OVERHEAD_HIGH = 380;
/**
 * Judge answer size per call, as billed: `completion` for Anthropic (whose
 * reasoning promptfoo already counts inside it), `completion +
 * completionDetails.reasoning` for Google, which reports the two apart.
 *
 * 183 is the mean billed output over the 26 `llm-rubric` components of the
 * committed runs, measured on 2026-09-29: the classify-email run
 * (`tests/fixtures/classify-email/results.json`, 6 Anthropic components,
 * 568 tokens), the extract-questions run
 * (`tests/fixtures/extract-questions/results.json`, 18 Anthropic
 * components, 3539 tokens) and `tests/fixtures/promptfoo-results-0.123.0.json`
 * (2 Google components, 642 tokens): 4749 / 26 = 182.7. The spread is wide
 * — one component billed 57, another 921 — because how long the judge
 * explains itself and how much hidden reasoning it pays for depend on the
 * answer it grades, which no constant can know before the run.
 */
export const JUDGE_OUTPUT_TOKENS = 183;
/**
 * The band a run's mean billed judge output fell in, over the same three
 * runs: classify-email 94.7, extract-questions 196.6, the Google fixture
 * 321.0 per call. A single call can go well past it (921 was billed once);
 * the band bounds the mean over a run, which is what the estimate charges.
 */
export const JUDGE_OUTPUT_TOKENS_LOW = 60;
export const JUDGE_OUTPUT_TOKENS_HIGH = 350;

/**
 * One model's share of the run. The point figures are characters/4 and the
 * point constants; the `Low`/`High` figures are the same counts through the
 * calibrated bands above, floored and ceiled, so the range is what a
 * recorded run could plausibly have cost rather than a single guess.
 */
export interface EstimateLine {
	model: string;
	role: "target" | "judge";
	calls: number;
	inputTokens: number;
	inputTokensLow: number;
	inputTokensHigh: number;
	outputTokens: number;
	outputTokensLow: number;
	outputTokensHigh: number;
	dollars: number;
	dollarsLow: number;
	dollarsHigh: number;
	pricedAs: string;
	approximate: boolean;
	/** False when the model's provider has no row at all in prices.yaml. */
	priced: boolean;
}

export interface Estimate {
	lines: EstimateLine[];
	cases: number;
	rubricCases: number;
	/** The priced lines' sums; an unpriced line adds nothing to any of the three. */
	totalDollars: number;
	totalDollarsLow: number;
	totalDollarsHigh: number;
	pricesUpdated: string;
	notes: string[];
}

export function approxTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
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
 * The size a single case's expected value would carry as output when it
 * stands for the whole answer the target wrote, or `null` when it does
 * not: a `rubric` expected value grades the target's answer rather than
 * being one, a case with no `expected` yet has nothing to measure, and a
 * `label` expected value only stands for the whole output when the
 * feature's own output is itself a bare label — checked against a `json`
 * or `text` output, "rejection" names one field of a larger answer, not
 * the whole thing, so it is left unmeasured rather than undercounting it.
 */
function measuredOutputSize(
	expected: Case["expected"],
	outputKind: Feature["output"]["kind"],
): number | null {
	if (expected === undefined) return null;
	if (expected.fields !== undefined)
		return approxTokens(JSON.stringify(expected.fields));
	if (expected.label !== undefined && outputKind === "label")
		return approxTokens(expected.label);
	return null;
}

interface MeasuredOutputSizes {
	mean: number;
	count: number;
}

/**
 * One pass over `cases`: the count and the mean (rounded up) of every
 * measurable expected value's size, together — `estimateSuite` needs both
 * the count (for its note) and the mean (for the output size), and reading
 * them from two separate traversals would run `measuredOutputSize` over
 * every case twice for no reason.
 */
function measureOutputSizes(
	cases: Case[],
	feature: Feature,
): MeasuredOutputSizes | null {
	let total = 0;
	let count = 0;
	for (const testCase of cases) {
		const size = measuredOutputSize(testCase.expected, feature.output.kind);
		if (size === null) continue;
		total += size;
		count += 1;
	}
	return count === 0 ? null : { mean: Math.ceil(total / count), count };
}

/**
 * The mean output size actually written into the reviewed cases' expected
 * values that stand for the whole output — a `fields` case as promptfoo
 * would serialise it back (`JSON.stringify`), a `label` case as the label
 * text itself but only when `feature.output.kind` is itself `"label"` —
 * rounded up. `null` when no selected case has one (every case is
 * rubric-only, every label is checked against a richer output shape, or
 * none carries an `expected` yet), which tells the caller to fall back to
 * the kind-based guess. This never compares its own result against that
 * guess — the caller floors it there, since a `fields` expected value may
 * name only some of the output's fields and must not undercut the guess.
 */
export function measuredOutputTokens(
	cases: Case[],
	feature: Feature,
): number | null {
	return measureOutputSizes(cases, feature)?.mean ?? null;
}

interface ChosenOutputSize {
	outputSize: number;
	/** Which size won and why, for the estimate's note. */
	note: string;
}

/**
 * The size to charge a single call's output tokens at: the measured mean
 * when the reviewed cases have one and it is at least the kind-based
 * guess, the guess otherwise. A low `fields` mean must never pull the
 * estimate under what the output's own shape already costs, because a
 * `fields` expected value can name only some of the output's fields. The
 * note tells the three outcomes apart: the mean won, the guess won over a
 * lower mean, or nothing was measurable.
 */
function chooseOutputSize(
	measured: MeasuredOutputSizes | null,
	guessedOutputSize: number,
): ChosenOutputSize {
	const guessNote = "output is estimated from output.kind, with no text basis";
	if (measured === null)
		return { outputSize: guessedOutputSize, note: guessNote };
	const reviewedValues = plural(measured.count, "reviewed expected value");
	if (measured.mean >= guessedOutputSize)
		return {
			outputSize: measured.mean,
			note: `output is the mean of ${reviewedValues}`,
		};
	return {
		outputSize: guessedOutputSize,
		note: `${guessNote}; the ${reviewedValues} measured below it`,
	};
}

function dollars(
	inputTokens: number,
	outputTokens: number,
	price: { input: number; output: number },
): number {
	return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Tokens counted as characters/4, re-counted at the band's fewest tokens per character. */
function fewestTokens(tokens: number): number {
	return (tokens * CHARACTERS_PER_TOKEN) / INPUT_CHARACTERS_PER_TOKEN_HIGH;
}

/** Tokens counted as characters/4, re-counted at the band's most tokens per character. */
function mostTokens(tokens: number): number {
	return (tokens * CHARACTERS_PER_TOKEN) / INPUT_CHARACTERS_PER_TOKEN_LOW;
}

type LineTokens = Pick<
	EstimateLine,
	| "model"
	| "role"
	| "calls"
	| "inputTokens"
	| "inputTokensLow"
	| "inputTokensHigh"
	| "outputTokens"
	| "outputTokensLow"
	| "outputTokensHigh"
>;

/** The line's three dollar figures, each from its own pair of token counts. */
function pricedLine(
	tokens: LineTokens,
	price: ReturnType<typeof priceFor>,
): EstimateLine {
	return {
		...tokens,
		dollars: dollars(tokens.inputTokens, tokens.outputTokens, price),
		dollarsLow: dollars(tokens.inputTokensLow, tokens.outputTokensLow, price),
		dollarsHigh: dollars(
			tokens.inputTokensHigh,
			tokens.outputTokensHigh,
			price,
		),
		pricedAs: price.pricedAs,
		approximate: price.approximate,
		priced: price.priced,
	};
}

const pricedSum = (
	lines: EstimateLine[],
	amountOf: (line: EstimateLine) => number,
): number =>
	// Stryker disable next-line MethodExpression: an unpriced line is priced at priceFor's 0/0 rates, so every dollar figure on it is 0 and summing it changes nothing; the filter states the intent, the totals cannot tell it apart
	lines
		.filter((line) => line.priced)
		.reduce((sum, line) => sum + amountOf(line), 0);

export function estimateSuite(parameters: {
	suite: Suite;
	selection: Selection;
	feature: Feature;
	prices: Prices;
	promptTokens: number;
}): Estimate {
	const { suite, selection, feature, prices, promptTokens } = parameters;
	const { outputSize, note: outputSizeNote } = chooseOutputSize(
		measureOutputSizes(selection.cases, feature),
		guessOutputTokens(feature.output),
	);
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
		lines.push(
			pricedLine(
				{
					model,
					role: "target",
					calls,
					inputTokens,
					inputTokensLow: Math.floor(fewestTokens(inputTokens)),
					inputTokensHigh: Math.ceil(mostTokens(inputTokens)),
					outputTokens,
					outputTokensLow: Math.floor(outputTokens * OUTPUT_GUESS_LOW_FACTOR),
					outputTokensHigh: Math.ceil(outputTokens * OUTPUT_GUESS_HIGH_FACTOR),
				},
				price,
			),
		);
	}
	// Each judge call reads the target's answer (the output band), the
	// rubric (the characters band) and promptfoo's own grading prompt (the
	// overhead band).
	const rubricTokens = rubricCases.map((testCase) =>
		// Stryker disable next-line OptionalChaining,StringLiteral: selectCases admits a case only with an expected value its scenario's oracle accepts, so every case of a rubric scenario reaching here carries a rubric; the fallback exists for the optional type alone
		approxTokens(testCase.expected?.rubric ?? ""),
	);
	const perRubricCase = (perCase: (tokens: number) => number): number =>
		rubricTokens.reduce((sum, tokens) => sum + perCase(tokens), 0);
	for (const judge of rubricCases.length > 0 ? suite.judges : []) {
		const price = priceFor(judge, prices);
		const perJudgeCalls = suite.target.models.length * suite.repeat;
		const calls = rubricCases.length * perJudgeCalls;
		lines.push(
			pricedLine(
				{
					model: judge,
					role: "judge",
					calls,
					inputTokens:
						perRubricCase(
							(tokens) => outputSize + tokens + JUDGE_PROMPT_OVERHEAD,
						) * perJudgeCalls,
					inputTokensLow: Math.floor(
						perRubricCase(
							(tokens) =>
								outputSize * OUTPUT_GUESS_LOW_FACTOR +
								fewestTokens(tokens) +
								JUDGE_PROMPT_OVERHEAD_LOW,
						) * perJudgeCalls,
					),
					inputTokensHigh: Math.ceil(
						perRubricCase(
							(tokens) =>
								outputSize * OUTPUT_GUESS_HIGH_FACTOR +
								mostTokens(tokens) +
								JUDGE_PROMPT_OVERHEAD_HIGH,
						) * perJudgeCalls,
					),
					outputTokens: calls * JUDGE_OUTPUT_TOKENS,
					outputTokensLow: calls * JUDGE_OUTPUT_TOKENS_LOW,
					outputTokensHigh: calls * JUDGE_OUTPUT_TOKENS_HIGH,
				},
				price,
			),
		);
	}
	const notes = [
		`tokens are counted as characters/4 and shown as a range calibrated on recorded runs; ${outputSizeNote}`,
	];
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
		totalDollars: pricedSum(lines, (line) => line.dollars),
		totalDollarsLow: pricedSum(lines, (line) => line.dollarsLow),
		totalDollarsHigh: pricedSum(lines, (line) => line.dollarsHigh),
		pricesUpdated: prices.updated,
		notes,
	};
}

/** What a line with no price at all prints where a dollar figure would go. */
const NOT_PRICED = "not priced";

/** `$low–$high (point $point)`: the range first, because it is the honest figure. */
function rangeText(low: number, high: number, point: number): string {
	return `$${low.toFixed(6)}–$${high.toFixed(6)} (point $${point.toFixed(6)})`;
}

export function renderEstimate(estimate: Estimate): string {
	const out = [
		`estimate: ${plural(estimate.cases, "case")}, ${estimate.rubricCases} with a rubric; prices dated ${estimate.pricesUpdated}`,
	];
	const rendered = estimate.lines.map((line) => {
		const marked = line.priced && line.approximate;
		const name = `${line.model}${marked ? " ~" : ""}`.padEnd(34);
		const dollarText = line.priced
			? rangeText(line.dollarsLow, line.dollarsHigh, line.dollars)
			: NOT_PRICED;
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
			: rangeText(
					estimate.totalDollarsLow,
					estimate.totalDollarsHigh,
					estimate.totalDollars,
				);
	const omitted =
		unpriced === 0 ? "" : `  (${plural(unpriced, "line")} not priced)`;
	out.push(
		`${label}${" ".repeat(Math.max(0, dollarColumn - label.length))}${figure}${omitted}`,
	);
	for (const note of estimate.notes) out.push(`note: ${note}`);
	return out.join("\n");
}
