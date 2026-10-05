import { z } from "zod";
import { fromPromptfooProvider } from "../emit/providers";
import { priceFor } from "../llm/prices";
import type { PromptfooResults, PromptfooRow } from "../report/results";
import { ForgeError } from "./errors";
import type { Estimate } from "./estimate";
import type { Case, Prices, Scenario } from "./schemas";

/**
 * `partly-errored` is a run that passed whenever it reached a verdict and
 * errored the rest of the time: nothing about the case was unstable, the
 * provider was, so calling it `flaky` reports an outage as a behaviour
 * change. A run that also failed an assert is `flaky`, because there the
 * verdicts themselves disagreed.
 */
export const StabilitySchema = z.enum([
	"stable",
	"flaky",
	"failing",
	"errored",
	"partly-errored",
]);

export const CaseRunSchema = z.object({
	case: z.string(),
	scenario: z.string(),
	model: z.string(),
	runs: z.number(),
	passed: z.number(),
	failed: z.number(),
	errored: z.number(),
	stability: StabilitySchema,
	reasons: z.array(z.string()),
});

export const JudgeVerdictSchema = z.object({
	judge: z.string(),
	pass: z.boolean(),
	reason: z.string(),
});

export const DisagreementSchema = z.object({
	case: z.string(),
	model: z.string(),
	/** How many runs of this (model, case) pair the judges split on. */
	occurrences: z.number(),
	/** The verdicts of the first disagreeing run; later runs are counted, not kept. */
	judges: z.array(JudgeVerdictSchema),
});

export const ScenarioStatSchema = z.object({
	scenario: z.string(),
	kind: z.string(),
	run: z.number(),
	passed: z.number(),
	failed: z.number(),
	errored: z.number(),
});

export const ModelCostSchema = z.object({
	model: z.string(),
	role: z.enum(["target", "judge"]),
	inputTokens: z.number(),
	outputTokens: z.number(),
	/** Null when the target never reported usage: no figure exists, and 0 would read as free. */
	realDollars: z.number().nullable(),
	/** The estimate's point figure; null when the line was not estimated or not priced. */
	estimatedDollars: z.number().nullable(),
	/**
	 * The estimate's calibrated range around the point. Null on the same
	 * lines as `estimatedDollars`, and defaulted to null so a `report.json`
	 * written before the range existed still loads as a `--baseline`.
	 */
	estimatedLowDollars: z.number().nullable().default(null),
	estimatedHighDollars: z.number().nullable().default(null),
	/** Real against the point estimate, in percent. */
	errorPercent: z.number().nullable(),
	approximatePrice: z.boolean(),
});

const BaselineDiffEntrySchema = z.object({
	case: z.string(),
	model: z.string(),
	before: StabilitySchema,
	after: StabilitySchema,
});

const BaselinePairSchema = z.object({ case: z.string(), model: z.string() });

/**
 * `reviewedScenarios` was called `approvedScenarios` until 2026-09-16.
 * `--baseline` takes a `report.json` an earlier run wrote, and the whole
 * point of the flag is that the earlier run is older than this binary: a
 * schema that knows only the new spelling rejects every file a person
 * actually has, naming it "not a report written by llm-tests-forge". The old key is read as the
 * new one when the new one is absent, and ignored when both are there, so
 * a file this version wrote is never reinterpreted by a stale field.
 */
function onlyApprovedScenarios(
	value: unknown,
): value is { approvedScenarios: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"approvedScenarios" in value &&
		!("reviewedScenarios" in value)
	);
}

const CoverageSchema = z.preprocess(
	(value) =>
		onlyApprovedScenarios(value)
			? { ...value, reviewedScenarios: value.approvedScenarios }
			: value,
	z.object({
		/** Scenarios a person passed on: `approved` and `edited` alike. */
		reviewedScenarios: z.number(),
		withRuns: z.number(),
		withoutCase: z.array(z.string()),
		/**
		 * Reviewed scenarios the suite selected, with at least one reviewed
		 * case and no matched row: after a rename (the rows are there, under
		 * the old ids), or a run that never reached them. The zero row in
		 * the table said so; the sentence did not — and it must not say
		 * "never ran", which is false in the rename case. A scenario the
		 * suite's `include` left out is never counted here, even when it has
		 * a reviewed case: see `notSelected`. Defaulted for older baselines.
		 */
		withoutRun: z.array(z.string()).default([]),
		/**
		 * Reviewed scenarios with a reviewed case on disk that the suite's
		 * `include` left out: this run never priced or ran them, so a zero
		 * row in the per-scenario table (or none at all) says nothing about
		 * whether the case still passes. Distinct from `withoutRun`, which
		 * keeps the scenarios the suite did select and that still matched no
		 * row. Defaulted for older baselines.
		 */
		notSelected: z.array(z.string()).default([]),
	}),
);

/**
 * Every field comes from this schema so `report.json` can be handed back as
 * `--baseline` without a second, drifting definition of what a report is.
 */
export const ReportSchema = z.object({
	generatedAt: z.string(),
	/** When promptfoo ran, from results.json; null for a results.json or a report.json that predates it, and for a hand-edited value that is not a string (one bad date must not refuse the whole report). */
	ranAt: z.string().nullable().default(null).catch(null),
	promptfooVersion: z.string().nullable(),
	rows: z.number(),
	matched: z.number(),
	unmatched: z.array(z.string()),
	/** Passed rows over the rows that reached a verdict (matched minus errored), 0..1. */
	passRate: z.number(),
	/** One per (model, case): model name order, then the order of the cases files. */
	cases: z.array(CaseRunSchema),
	/**
	 * `"case @ model"` for every CaseRun that never passed cleanly: stability
	 * `failing`, `errored` or `partly-errored` — the name says less than the
	 * list holds, and it stays because every `--baseline` written so far
	 * spells it this way. The string is a display form: a case id that
	 * itself contains ` @ ` makes two different pairs spell the same entry,
	 * so `failingPairs` is the unambiguous form of the same list. Defaulted
	 * so a `report.json` written before this field existed is still
	 * readable as a `--baseline`; the diff reads `cases`, never this list.
	 */
	failing: z.array(z.string()).default([]),
	/** The same pairs as `failing`, structured. Defaulted for the same reason. */
	failingPairs: z
		.array(z.object({ case: z.string(), model: z.string() }))
		.default([]),
	/** `"case @ model"` for every CaseRun whose stability is `flaky`. */
	flaky: z.array(z.string()),
	scenarios: z.array(ScenarioStatSchema),
	coverage: CoverageSchema,
	disagreements: z.array(DisagreementSchema),
	costs: z.array(ModelCostSchema),
	targetUsageReported: z.boolean(),
	baseline: z
		.object({
			regressions: z.array(BaselineDiffEntrySchema),
			fixed: z.array(BaselineDiffEntrySchema),
			/**
			 * Pairs the baseline has and this run does not. A pair only one
			 * side has says nothing about a change, so it is rightly left
			 * out of the two lists above — but after a `llm-tests-forge move` every
			 * renamed pair lands here, and without this list the diff read
			 * as "nothing changed" rather than "nothing could be compared".
			 * Defaulted for older baselines.
			 */
			onlyInBaseline: z.array(BaselinePairSchema).default([]),
		})
		.nullable(),
});

export type Stability = z.infer<typeof StabilitySchema>;
export type CaseRun = z.infer<typeof CaseRunSchema>;
export type Disagreement = z.infer<typeof DisagreementSchema>;
export type ScenarioStat = z.infer<typeof ScenarioStatSchema>;
export type ModelCost = z.infer<typeof ModelCostSchema>;
export type Report = z.infer<typeof ReportSchema>;

type Outcome = "passed" | "failed" | "errored";

interface MatchedRow {
	row: PromptfooRow;
	kase: Case;
	model: string;
	outcome: Outcome;
	reasons: string[];
}

const round = (value: number, places: number): number =>
	Math.round(value * 10 ** places) / 10 ** places;

/**
 * The name the forge would have written, whenever it can be recovered: a
 * provider promptfoo recorded without a label (a hand-written config, an
 * older emit) otherwise comes back as a raw promptfoo id, which no other
 * table in the report — the estimate, `prices.yaml` — is keyed by. An id
 * this forge did not write keeps its raw spelling, because inventing a
 * name for it would be worse than showing what the file says.
 */
function modelOf(row: PromptfooRow): string {
	return (
		row.provider.label ??
		fromPromptfooProvider(row.provider.id) ??
		row.provider.id
	);
}

/** promptfoo 0.123.0's `failureReason` for "the provider itself errored". */
const PROVIDER_ERROR = 2;

/**
 * `error` cannot tell an error from a failure: promptfoo writes the failing
 * assert's reason there too, so reading it alone reports every ordinary
 * failure as an error (measured on the committed example run: 3 failed
 * assertions came back as 3 errors). `failureReason` is the field that
 * separates them; a file old enough not to have it is judged by
 * `response.error`, which only a provider failure sets.
 */
function providerErrored(row: PromptfooRow): boolean {
	const failureReason = row.failureReason ?? undefined;
	if (failureReason !== undefined) return failureReason === PROVIDER_ERROR;
	return (row.response?.error ?? null) !== null;
}

/**
 * An error is not a failure: a row that never reached the judge says
 * nothing about the case, so it is counted apart everywhere below and its
 * `error` is the only reason worth reporting. A failure reports why the
 * asserts said no, falling back to `error` when no component named a
 * reason.
 */
function outcomeOf(row: PromptfooRow): { outcome: Outcome; reasons: string[] } {
	if (row.success) return { outcome: "passed", reasons: [] };
	const fallback = row.error ? [row.error] : [];
	if (providerErrored(row)) return { outcome: "errored", reasons: fallback };
	const reasons: string[] = [];
	// Stryker disable next-line ArrayDeclaration: any placeholder element in the empty fallback has neither pass nor reason, so the check below skips it exactly as it skips nothing
	for (const component of row.gradingResult?.componentResults ?? [])
		if (!component.pass && component.reason !== undefined)
			reasons.push(component.reason);
	return {
		outcome: "failed",
		reasons: reasons.length > 0 ? reasons : fallback,
	};
}

function stabilityOf(parameters: {
	runs: number;
	passed: number;
	failed: number;
	errored: number;
}): Stability {
	const { runs, passed, failed, errored } = parameters;
	if (errored === runs) return "errored";
	// Some runs errored and none failed; since not all of them errored (the
	// line above), the rest passed. Checking `passed > 0` too would state
	// the same thing twice.
	if (errored > 0 && failed === 0) return "partly-errored";
	if (passed === runs) return "stable";
	if (passed > 0) return "flaky";
	return "failing";
}

/** The forge's own model name when this forge emitted the provider, else whatever promptfoo recorded. */
function judgeName(provider: string | undefined): string {
	if (provider === undefined) return "unknown judge";
	return fromPromptfooProvider(provider) ?? provider;
}

/**
 * Whether a judge's `completionDetails.reasoning` is billed on top of its
 * `completion`. Google (and Vertex's Gemini) report the hidden reasoning
 * apart from the answer, so leaving it out understates a thinking judge
 * severalfold. Anthropic does not: promptfoo 0.123.0 maps Anthropic's
 * `output_tokens` to `completion` and its `thinking_tokens` to the
 * reasoning detail, so the reasoning is already inside `completion` and
 * adding it counted it twice. Vertex's Claude goes through that same
 * Anthropic mapping: promptfoo 0.123.0's Vertex provider sends any model
 * whose name includes "claude" to its Claude call, which reads usage with
 * the Anthropic `getTokenUsage` (read in its dist). Every other provider
 * is taken to include it too, as OpenAI's API documents for
 * `completion_tokens` (not measured on a run here).
 */
function reasoningBilledApart(provider: string | undefined): boolean {
	return (
		provider !== undefined &&
		(provider.startsWith("google:") ||
			(provider.startsWith("vertex:") && !provider.includes("claude")))
	);
}

function reviewed(status: Scenario["status"]): boolean {
	return status === "approved" || status === "edited";
}

function rubricComponents(row: PromptfooRow) {
	// Stryker disable next-line ArrayDeclaration: a placeholder element in the empty fallback has no assertion, so the filter drops it and the result is empty either way
	return (row.gradingResult?.componentResults ?? []).filter(
		(component) => component.assertion?.type === "llm-rubric",
	);
}

/** An unambiguous Map key for a (model, case) pair, whatever either contains. */
function pairKey(model: string, caseId: string): string {
	return JSON.stringify([model, caseId]);
}

/**
 * Rows are matched against the selection the estimate priced, not against
 * every case on disk: a rejected or pending case that still has a row in
 * `results.json` (an older run, a hand-edited config) would otherwise be
 * counted into a pass rate the person never asked for. Such a row is named
 * as what it is, so it reads as a stale row rather than as a typo.
 */
function matchRows(
	results: PromptfooResults,
	cases: Case[],
	knownCases: Case[],
	resultsPath: string,
): { matched: MatchedRow[]; unmatched: string[] } {
	// Keyed by `unknown` so any `metadata.case` can be looked up as it is:
	// a number, a null or a missing one finds nothing, since every key is a
	// case id string.
	const caseById = new Map<unknown, Case>(
		cases.map((selectedCase) => [selectedCase.id, selectedCase]),
	);
	const known = new Set(knownCases.map((knownCase) => knownCase.id));
	const matched: MatchedRow[] = [];
	const unmatched: string[] = [];
	for (const [position, row] of results.results.results.entries()) {
		const id = row.metadata?.case;
		const kase = caseById.get(id);
		if (kase) {
			matched.push({ row, kase, model: modelOf(row), ...outcomeOf(row) });
			continue;
		}
		let named: string;
		if (typeof id !== "string") named = "no metadata.case";
		else named = known.has(id) ? `${id} (not in the current selection)` : id;
		// Position in the array, not `testIdx`: promptfoo gives every repeat
		// of a test the same `testIdx`, so with `repeat > 1` the index names
		// two rows identically and neither can be found in the file.
		unmatched.push(
			`row ${position} (testIdx ${row.testIdx}): ${modelOf(row)}: ${named}`,
		);
	}
	if (matched.length === 0) {
		// The first id the file actually carries tells a config emitted by
		// something else (ids from another tool, or none at all) from a typo
		// in one case id, which read identically before.
		const seen = results.results.results
			.map((resultRow) => resultRow.metadata?.case)
			.find((id) => typeof id === "string");
		const observed = seen === undefined ? "none" : `"${seen}"`;
		throw new ForgeError(
			`no result matches a case in .forge/cases (first metadata.case seen: ${observed}, ${results.results.results.length} rows); was this results.json produced from a config llm-tests-forge emitted?`,
			{ file: resultsPath },
		);
	}
	return { matched, unmatched };
}

/**
 * Models sorted by name and cases in the order of the cases files, so two
 * runs of the same suite produce byte-identical reports and a diff of
 * `report.json` shows behaviour changing rather than rows moving.
 */
function caseRunsOf(matched: MatchedRow[], cases: Case[]): CaseRun[] {
	const byPair = new Map<string, MatchedRow[]>();
	for (const matchedRow of matched) {
		const key = pairKey(matchedRow.model, matchedRow.kase.id);
		const list = byPair.get(key);
		if (list) list.push(matchedRow);
		else byPair.set(key, [matchedRow]);
	}
	const models = [
		...new Set(matched.map((matchedRow) => matchedRow.model)),
	].sort();
	const runs: CaseRun[] = [];
	for (const model of models) {
		for (const kase of cases) {
			const entries = byPair.get(pairKey(model, kase.id));
			if (!entries) continue;
			const passed = entries.filter(
				(entry) => entry.outcome === "passed",
			).length;
			const failed = entries.filter(
				(entry) => entry.outcome === "failed",
			).length;
			const errored = entries.filter(
				(entry) => entry.outcome === "errored",
			).length;
			runs.push({
				case: kase.id,
				scenario: kase.scenario,
				model,
				runs: entries.length,
				passed,
				failed,
				errored,
				stability: stabilityOf({
					runs: entries.length,
					passed,
					failed,
					errored,
				}),
				reasons: [...new Set(entries.flatMap((entry) => entry.reasons))],
			});
		}
	}
	return runs;
}

function scenarioStatsOf(
	matched: MatchedRow[],
	scenarios: Scenario[],
): ScenarioStat[] {
	return scenarios
		.filter((scenario) => reviewed(scenario.status))
		.map((scenario) => {
			const mine = matched.filter(
				(matchedRow) => matchedRow.kase.scenario === scenario.id,
			);
			return {
				scenario: scenario.id,
				kind: scenario.kind,
				run: mine.length,
				passed: mine.filter((matchedRow) => matchedRow.outcome === "passed")
					.length,
				failed: mine.filter((matchedRow) => matchedRow.outcome === "failed")
					.length,
				errored: mine.filter((matchedRow) => matchedRow.outcome === "errored")
					.length,
			};
		});
}

/**
 * One entry per (model, case) pair whose rubric judges did not all agree,
 * not one per row: with `repeat: 2` a case the judges always split on was
 * counted twice in the headline, which reads as two separate disagreements
 * to look into. The verdicts shown are the first disagreeing run's, and
 * `occurrences` says how often the split happened; the later runs' reasons
 * are prose saying the same thing, so they are counted rather than kept.
 */
function disagreementsOf(matched: MatchedRow[]): Disagreement[] {
	const byPair = new Map<string, Disagreement>();
	const out: Disagreement[] = [];
	for (const matchedRow of matched) {
		const judges = rubricComponents(matchedRow.row).map((component) => ({
			// Stryker disable next-line OptionalChaining: rubricComponents keeps only components whose assertion is there (its type is llm-rubric)
			judge: judgeName(component.assertion?.provider),
			pass: component.pass,
			reason: component.reason ?? "",
		}));
		// Fewer than two distinct verdicts is agreement, and it covers a lone
		// judge (one verdict) and a row with no judge (none) as well.
		if (new Set(judges.map((judge) => judge.pass)).size < 2) continue;
		const key = pairKey(matchedRow.model, matchedRow.kase.id);
		const seen = byPair.get(key);
		if (seen) {
			seen.occurrences += 1;
			continue;
		}
		const entry: Disagreement = {
			case: matchedRow.kase.id,
			model: matchedRow.model,
			occurrences: 1,
			judges,
		};
		byPair.set(key, entry);
		out.push(entry);
	}
	return out;
}

function costLine(parameters: {
	model: string;
	role: "target" | "judge";
	inputTokens: number;
	outputTokens: number;
	realDollars: number | null;
	approximatePrice: boolean;
	estimate: Estimate | null;
}): ModelCost {
	const { model, role, realDollars, estimate } = parameters;
	const matchingLine = estimate?.lines.find(
		(line) => line.model === model && line.role === role,
	);
	return {
		model,
		role,
		inputTokens: parameters.inputTokens,
		outputTokens: parameters.outputTokens,
		realDollars: realDollars === null ? null : round(realDollars, 6),
		// An unpriced line's `dollars` is 0 because no rate existed, not
		// because the run was free: the estimate column says so with a dash
		// rather than pricing the model at nothing.
		estimatedDollars: matchingLine?.priced
			? round(matchingLine.dollars, 6)
			: null,
		estimatedLowDollars: matchingLine?.priced
			? round(matchingLine.dollarsLow, 6)
			: null,
		estimatedHighDollars: matchingLine?.priced
			? round(matchingLine.dollarsHigh, 6)
			: null,
		errorPercent:
			realDollars !== null && matchingLine && matchingLine.dollars > 0
				? round(
						((realDollars - matchingLine.dollars) / matchingLine.dollars) * 100,
						1,
					)
				: null,
		approximatePrice: parameters.approximatePrice,
	};
}

const sum = <T>(items: T[], amountOf: (item: T) => number): number =>
	items.reduce((total, item) => total + amountOf(item), 0);

/**
 * A target that reports its own `cost` is believed; a shim that reports
 * only tokens (or nothing at all) is priced from `prices.yaml`, which is
 * also the only source a judge ever has — promptfoo bills rubric calls
 * inside the assertion and never reports a dollar figure for them.
 */
function costsOf(parameters: {
	matched: MatchedRow[];
	prices: Prices;
	estimate: Estimate | null;
	targetUsageReported: boolean;
}): ModelCost[] {
	const { matched, prices, estimate, targetUsageReported } = parameters;
	const costs: ModelCost[] = [];
	for (const model of [
		...new Set(matched.map((matchedRow) => matchedRow.model)),
	].sort()) {
		const mine = matched.filter((matchedRow) => matchedRow.model === model);
		const inputTokens = sum(
			mine,
			(matchedRow) => matchedRow.row.tokenUsage?.prompt ?? 0,
		);
		const outputTokens = sum(
			mine,
			(matchedRow) => matchedRow.row.tokenUsage?.completion ?? 0,
		);
		const price = priceFor(model, prices);
		const reported = mine.some((matchedRow) => (matchedRow.row.cost ?? 0) > 0);
		costs.push(
			costLine({
				model,
				role: "target",
				inputTokens,
				outputTokens,
				// A shim that reported nothing has no cost, not a cost of
				// zero: pricing its silence would print a saving it did not
				// make, and an error percent of -100% against the estimate.
				// A reported cost needs no rate at all — it is believed as
				// it stands, unpriced provider or not. Only the fallback to
				// a computed figure needs a table row: a provider with no
				// row has no basis for that computation, so it reports no
				// cost rather than a real dollar figure computed from a 0
				// rate.
				realDollars: !targetUsageReported
					? null
					: reported
						? sum(mine, (matchedRow) => matchedRow.row.cost ?? 0)
						: price.priced
							? (inputTokens * price.input + outputTokens * price.output) / 1e6
							: null,
				// `~` says "this dollar figure came from the closest listed
				// model". When promptfoo reported the cost itself no table
				// lookup happened, so marking it would be a lie; and a
				// model with no row at all was never priced as anything,
				// so `price.approximate` alone (true for both cases) would
				// lie too.
				approximatePrice: reported ? false : price.priced && price.approximate,
				estimate,
			}),
		);
	}
	// One entry per rubric call, grouped by judge the same way the targets
	// are grouped by model above: names sorted, then each one's calls summed.
	const judgeCalls = matched.flatMap((matchedRow) =>
		rubricComponents(matchedRow.row).map((component) => {
			// Stryker disable next-line OptionalChaining: rubricComponents keeps only components whose assertion is there (its type is llm-rubric)
			const provider = component.assertion?.provider;
			return {
				name: judgeName(provider),
				provider,
				tokens: component.tokensUsed,
			};
		}),
	);
	for (const name of [...new Set(judgeCalls.map((call) => call.name))].sort()) {
		const mine = judgeCalls.filter((call) => call.name === name);
		const inputTokens = sum(mine, (call) => call.tokens?.prompt ?? 0);
		const outputTokens = sum(
			mine,
			(call) =>
				(call.tokens?.completion ?? 0) +
				(reasoningBilledApart(call.provider)
					? (call.tokens?.completionDetails?.reasoning ?? 0)
					: 0),
		);
		const price = priceFor(name, prices);
		costs.push(
			costLine({
				model: name,
				role: "judge",
				inputTokens,
				outputTokens,
				// A judge is always priced from the table (promptfoo never
				// reports its cost), so an unpriced provider has no basis
				// for a dollar figure at all.
				realDollars: price.priced
					? (inputTokens * price.input + outputTokens * price.output) / 1e6
					: null,
				approximatePrice: price.priced && price.approximate,
				estimate,
			}),
		);
	}
	return costs;
}

/**
 * A case worth looking at first: it never passed, or it only passed when
 * the provider let it. Exported so the Markdown table and this JSON list
 * cannot come to disagree about what "failing or errored" means.
 */
export function notPassingCleanly(caseRun: CaseRun): boolean {
	return caseRun.stability !== "stable" && caseRun.stability !== "flaky";
}

function baselineDiffOf(
	caseRuns: CaseRun[],
	baseline: Report | null,
): Report["baseline"] {
	if (!baseline) return null;
	const before = new Map(
		baseline.cases.map((caseRun) => [
			pairKey(caseRun.model, caseRun.case),
			caseRun.stability,
		]),
	);
	const regressions: z.infer<typeof BaselineDiffEntrySchema>[] = [];
	const fixed: z.infer<typeof BaselineDiffEntrySchema>[] = [];
	const seen = new Set<string>();
	for (const caseRun of caseRuns) {
		seen.add(pairKey(caseRun.model, caseRun.case));
		const was = before.get(pairKey(caseRun.model, caseRun.case));
		// A pair only one run has says nothing about a change.
		if (was === undefined) continue;
		const entry = {
			case: caseRun.case,
			model: caseRun.model,
			before: was,
			after: caseRun.stability,
		};
		if (was === "stable" && caseRun.stability !== "stable")
			regressions.push(entry);
		else if (was !== "stable" && caseRun.stability === "stable")
			fixed.push(entry);
	}
	const onlyInBaseline = baseline.cases
		.filter((caseRun) => !seen.has(pairKey(caseRun.model, caseRun.case)))
		.map((caseRun) => ({ case: caseRun.case, model: caseRun.model }));
	return { regressions, fixed, onlyInBaseline };
}

/**
 * The calendar day of an ISO timestamp, or null when the value is not one:
 * `Date.parse` alone takes "Tue Sep 16 2026" and cutting the first ten
 * characters of anything else would show garbage as if it were a date.
 * `Date.parse` also rolls a day the calendar does not have into the next
 * month (2026-02-30 is March 2), so the written day is rebuilt from its
 * parts and must come back the same. The day is the one written, whatever
 * the offset.
 */
export function isoDay(timestamp: string): string | null {
	// `match`, not `exec`: exec would coerce a missing value to the text
	// "undefined" and quietly find no day, hiding a caller that skipped its
	// own check; match on a missing value throws.
	const day = timestamp.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1];
	if (day === undefined || Number.isNaN(Date.parse(timestamp))) return null;
	// setUTCFullYear, not Date.UTC: Date.UTC reads a year below 100 as 19xx.
	const calendar = new Date(0);
	calendar.setUTCFullYear(
		Number(day.slice(0, 4)),
		Number(day.slice(5, 7)) - 1,
		Number(day.slice(8, 10)),
	);
	return calendar.toISOString().slice(0, 10) === day ? day : null;
}

/** The timestamp promptfoo recorded, or null when it is absent, empty or not an ISO date: the same test `status` reads it by. */
function recordedRunTime(timestamp: string | undefined): string | null {
	if (timestamp === undefined || isoDay(timestamp) === null) return null;
	return timestamp;
}

export function buildReport(parameters: {
	results: PromptfooResults;
	resultsPath: string;
	scenarios: Scenario[];
	/** The cases the suite selected: the only ones a result row may match. */
	cases: Case[];
	/** Every case on disk, so a row naming an unselected one says so. */
	knownCases: Case[];
	/** The scenario ids `selectCases` returned: the suite's actual selection. */
	selectedScenarios: string[];
	estimate: Estimate | null;
	prices: Prices;
	baseline: Report | null;
	now: Date;
}): Report {
	const { results, resultsPath, scenarios, cases, estimate, prices } =
		parameters;
	const { matched, unmatched } = matchRows(
		results,
		cases,
		parameters.knownCases,
		resultsPath,
	);
	const caseRuns = caseRunsOf(matched, cases);
	const reviewedScenarios = scenarios.filter((scenario) =>
		reviewed(scenario.status),
	);
	const scenarioStats = scenarioStatsOf(matched, scenarios);
	// Every case on disk, not the suite's selection: a scenario the suite
	// left out still has its cases, and "no case yet" said otherwise for
	// every scenario outside a narrowed `include`. Those land under
	// `notSelected` (or `withoutRun`, once selected), which is true of them.
	const withCase = new Set(
		parameters.knownCases
			.filter((knownCase) => reviewed(knownCase.status))
			.map((knownCase) => knownCase.scenario),
	);
	const selectedScenarios = new Set(parameters.selectedScenarios);
	// An errored row never reached a verdict, so it is neither a pass nor a
	// failure: counting it as a non-pass reports a model outage as a
	// behaviour change.
	const passed = matched.filter(
		(matchedRow) => matchedRow.outcome === "passed",
	).length;
	const erroredRows = matched.filter(
		(matchedRow) => matchedRow.outcome === "errored",
	).length;
	const judged = matched.length - erroredRows;
	const targetUsageReported = matched.some(
		(matchedRow) =>
			(matchedRow.row.cost ?? 0) > 0 ||
			(matchedRow.row.tokenUsage?.total ?? 0) > 0,
	);
	return {
		generatedAt: parameters.now.toISOString(),
		ranAt: recordedRunTime(results.results.timestamp),
		promptfooVersion: results.metadata?.promptfooVersion ?? null,
		rows: results.results.results.length,
		matched: matched.length,
		unmatched,
		passRate: judged === 0 ? 0 : round(passed / judged, 4),
		cases: caseRuns,
		failing: caseRuns
			.filter(notPassingCleanly)
			.map((caseRun) => `${caseRun.case} @ ${caseRun.model}`),
		failingPairs: caseRuns
			.filter(notPassingCleanly)
			.map((caseRun) => ({ case: caseRun.case, model: caseRun.model })),
		flaky: caseRuns
			.filter((caseRun) => caseRun.stability === "flaky")
			.map((caseRun) => `${caseRun.case} @ ${caseRun.model}`),
		scenarios: scenarioStats,
		coverage: {
			reviewedScenarios: reviewedScenarios.length,
			withRuns: scenarioStats.filter((stat) => stat.run > 0).length,
			withoutCase: reviewedScenarios
				.filter((scenario) => !withCase.has(scenario.id))
				.map((scenario) => scenario.id),
			withoutRun: reviewedScenarios
				.filter((scenario) => withCase.has(scenario.id))
				.filter((scenario) => selectedScenarios.has(scenario.id))
				.filter(
					(scenario) =>
						!scenarioStats.some(
							(stat) => stat.scenario === scenario.id && stat.run > 0,
						),
				)
				.map((scenario) => scenario.id),
			notSelected: reviewedScenarios
				.filter((scenario) => withCase.has(scenario.id))
				.filter((scenario) => !selectedScenarios.has(scenario.id))
				.map((scenario) => scenario.id),
		},
		disagreements: disagreementsOf(matched),
		costs: costsOf({ matched, prices, estimate, targetUsageReported }),
		targetUsageReported,
		baseline: baselineDiffOf(caseRuns, parameters.baseline),
	};
}
