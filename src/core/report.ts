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
	estimatedDollars: z.number().nullable(),
	errorPercent: z.number().nullable(),
	approximatePrice: z.boolean(),
});

const BaselineDiffEntrySchema = z.object({
	case: z.string(),
	model: z.string(),
	before: StabilitySchema,
	after: StabilitySchema,
});

/**
 * Every field comes from this schema so `report.json` can be handed back as
 * `--baseline` without a second, drifting definition of what a report is.
 */
export const ReportSchema = z.object({
	generatedAt: z.string(),
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
	 * `failing`, `errored` or `partly-errored`. Defaulted so a `report.json`
	 * written before this field existed is still readable as a `--baseline`;
	 * the diff reads `cases`, never this list.
	 */
	failing: z.array(z.string()).default([]),
	/** `"case @ model"` for every CaseRun whose stability is `flaky`. */
	flaky: z.array(z.string()),
	scenarios: z.array(ScenarioStatSchema),
	coverage: z.object({
		/** Scenarios a person passed on: `approved` and `edited` alike. */
		reviewedScenarios: z.number(),
		withRuns: z.number(),
		withoutCase: z.array(z.string()),
	}),
	disagreements: z.array(DisagreementSchema),
	costs: z.array(ModelCostSchema),
	targetUsageReported: z.boolean(),
	baseline: z
		.object({
			regressions: z.array(BaselineDiffEntrySchema),
			fixed: z.array(BaselineDiffEntrySchema),
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

const round = (n: number, places: number): number =>
	Math.round(n * 10 ** places) / 10 ** places;

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
	for (const c of row.gradingResult?.componentResults ?? [])
		if (!c.pass && c.reason !== undefined) reasons.push(c.reason);
	return {
		outcome: "failed",
		reasons: reasons.length > 0 ? reasons : fallback,
	};
}

function stabilityOf(args: {
	runs: number;
	passed: number;
	failed: number;
	errored: number;
}): Stability {
	const { runs, passed, failed, errored } = args;
	if (errored === runs) return "errored";
	if (errored > 0 && failed === 0 && passed > 0) return "partly-errored";
	if (passed === runs) return "stable";
	if (passed > 0) return "flaky";
	return "failing";
}

/** The forge's own model name when this forge emitted the provider, else whatever promptfoo recorded. */
function judgeName(provider: string | undefined): string {
	if (provider === undefined) return "unknown judge";
	return fromPromptfooProvider(provider) ?? provider;
}

function reviewed(status: Scenario["status"]): boolean {
	return status === "approved" || status === "edited";
}

function rubricComponents(row: PromptfooRow) {
	return (row.gradingResult?.componentResults ?? []).filter(
		(c) => c.assertion?.type === "llm-rubric",
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
	const caseById = new Map(cases.map((c) => [c.id, c]));
	const known = new Set(knownCases.map((c) => c.id));
	const matched: MatchedRow[] = [];
	const unmatched: string[] = [];
	for (const [position, row] of results.results.results.entries()) {
		const id = row.metadata?.case;
		const kase = typeof id === "string" ? caseById.get(id) : undefined;
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
			.map((r) => r.metadata?.case)
			.find((id) => typeof id === "string");
		const observed = seen === undefined ? "none" : `"${seen}"`;
		throw new ForgeError(
			`no result matches a case in .forge/cases (first metadata.case seen: ${observed}, ${results.results.results.length} rows); was this results.json produced from a config forge emitted?`,
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
	for (const m of matched) {
		const key = pairKey(m.model, m.kase.id);
		const list = byPair.get(key);
		if (list) list.push(m);
		else byPair.set(key, [m]);
	}
	const models = [...new Set(matched.map((m) => m.model))].sort();
	const runs: CaseRun[] = [];
	for (const model of models) {
		for (const kase of cases) {
			const entries = byPair.get(pairKey(model, kase.id));
			if (!entries) continue;
			const passed = entries.filter((e) => e.outcome === "passed").length;
			const failed = entries.filter((e) => e.outcome === "failed").length;
			const errored = entries.filter((e) => e.outcome === "errored").length;
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
				reasons: [...new Set(entries.flatMap((e) => e.reasons))],
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
		.filter((s) => reviewed(s.status))
		.map((s) => {
			const mine = matched.filter((m) => m.kase.scenario === s.id);
			return {
				scenario: s.id,
				kind: s.kind,
				run: mine.length,
				passed: mine.filter((m) => m.outcome === "passed").length,
				failed: mine.filter((m) => m.outcome === "failed").length,
				errored: mine.filter((m) => m.outcome === "errored").length,
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
	for (const m of matched) {
		const judges = rubricComponents(m.row).map((c) => ({
			judge: judgeName(c.assertion?.provider),
			pass: c.pass,
			reason: c.reason ?? "",
		}));
		if (judges.length < 2) continue;
		if (new Set(judges.map((j) => j.pass)).size < 2) continue;
		const key = pairKey(m.model, m.kase.id);
		const seen = byPair.get(key);
		if (seen) {
			seen.occurrences += 1;
			continue;
		}
		const entry: Disagreement = {
			case: m.kase.id,
			model: m.model,
			occurrences: 1,
			judges,
		};
		byPair.set(key, entry);
		out.push(entry);
	}
	return out;
}

function costLine(args: {
	model: string;
	role: "target" | "judge";
	inputTokens: number;
	outputTokens: number;
	realDollars: number | null;
	approximatePrice: boolean;
	estimate: Estimate | null;
}): ModelCost {
	const { model, role, realDollars, estimate } = args;
	const line = estimate?.lines.find(
		(l) => l.model === model && l.role === role,
	);
	return {
		model,
		role,
		inputTokens: args.inputTokens,
		outputTokens: args.outputTokens,
		realDollars: realDollars === null ? null : round(realDollars, 6),
		// An unpriced line's `dollars` is 0 because no rate existed, not
		// because the run was free: the estimate column says so with a dash
		// rather than pricing the model at nothing.
		estimatedDollars: line?.priced ? round(line.dollars, 6) : null,
		errorPercent:
			realDollars !== null && line && line.dollars > 0
				? round(((realDollars - line.dollars) / line.dollars) * 100, 1)
				: null,
		approximatePrice: args.approximatePrice,
	};
}

const sum = <T>(items: T[], of: (item: T) => number): number =>
	items.reduce((total, item) => total + of(item), 0);

/**
 * A target that reports its own `cost` is believed; a shim that reports
 * only tokens (or nothing at all) is priced from `prices.yaml`, which is
 * also the only source a judge ever has — promptfoo bills rubric calls
 * inside the assertion and never reports a dollar figure for them.
 */
function costsOf(args: {
	matched: MatchedRow[];
	prices: Prices;
	estimate: Estimate | null;
	targetUsageReported: boolean;
}): ModelCost[] {
	const { matched, prices, estimate, targetUsageReported } = args;
	const costs: ModelCost[] = [];
	for (const model of [...new Set(matched.map((m) => m.model))].sort()) {
		const mine = matched.filter((m) => m.model === model);
		const inputTokens = sum(mine, (m) => m.row.tokenUsage?.prompt ?? 0);
		const outputTokens = sum(mine, (m) => m.row.tokenUsage?.completion ?? 0);
		const price = priceFor(model, prices);
		const reported = mine.some((m) => (m.row.cost ?? 0) > 0);
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
						? sum(mine, (m) => m.row.cost ?? 0)
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
	const judges = new Map<string, { input: number; output: number }>();
	for (const m of matched)
		for (const c of rubricComponents(m.row)) {
			const name = judgeName(c.assertion?.provider);
			const totals = judges.get(name) ?? { input: 0, output: 0 };
			totals.input += c.tokensUsed?.prompt ?? 0;
			// Providers that bill hidden reasoning report it apart from the
			// answer; leaving it out understates a thinking judge severalfold.
			totals.output +=
				(c.tokensUsed?.completion ?? 0) +
				(c.tokensUsed?.completionDetails?.reasoning ?? 0);
			judges.set(name, totals);
		}
	for (const [name, totals] of [...judges.entries()].sort((a, b) =>
		a[0] < b[0] ? -1 : 1,
	)) {
		const price = priceFor(name, prices);
		costs.push(
			costLine({
				model: name,
				role: "judge",
				inputTokens: totals.input,
				outputTokens: totals.output,
				// A judge is always priced from the table (promptfoo never
				// reports its cost), so an unpriced provider has no basis
				// for a dollar figure at all.
				realDollars: price.priced
					? (totals.input * price.input + totals.output * price.output) / 1e6
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
export function notPassingCleanly(c: CaseRun): boolean {
	return c.stability !== "stable" && c.stability !== "flaky";
}

function baselineDiffOf(
	caseRuns: CaseRun[],
	baseline: Report | null,
): Report["baseline"] {
	if (!baseline) return null;
	const before = new Map(
		baseline.cases.map((c) => [pairKey(c.model, c.case), c.stability]),
	);
	const regressions: z.infer<typeof BaselineDiffEntrySchema>[] = [];
	const fixed: z.infer<typeof BaselineDiffEntrySchema>[] = [];
	for (const c of caseRuns) {
		const was = before.get(pairKey(c.model, c.case));
		// A pair only one run has says nothing about a change.
		if (was === undefined) continue;
		const entry = {
			case: c.case,
			model: c.model,
			before: was,
			after: c.stability,
		};
		if (was === "stable" && c.stability !== "stable") regressions.push(entry);
		else if (was !== "stable" && c.stability === "stable") fixed.push(entry);
	}
	return { regressions, fixed };
}

export function buildReport(args: {
	results: PromptfooResults;
	resultsPath: string;
	scenarios: Scenario[];
	/** The cases the suite selected: the only ones a result row may match. */
	cases: Case[];
	/** Every case on disk, so a row naming an unselected one says so. */
	knownCases: Case[];
	estimate: Estimate | null;
	prices: Prices;
	baseline: Report | null;
	now: Date;
}): Report {
	const { results, resultsPath, scenarios, cases, estimate, prices } = args;
	const { matched, unmatched } = matchRows(
		results,
		cases,
		args.knownCases,
		resultsPath,
	);
	const caseRuns = caseRunsOf(matched, cases);
	const reviewedScenarios = scenarios.filter((s) => reviewed(s.status));
	const scenarioStats = scenarioStatsOf(matched, scenarios);
	const withCase = new Set(
		cases.filter((c) => reviewed(c.status)).map((c) => c.scenario),
	);
	// An errored row never reached a verdict, so it is neither a pass nor a
	// failure: counting it as a non-pass reports a model outage as a
	// behaviour change.
	const passed = matched.filter((m) => m.outcome === "passed").length;
	const erroredRows = matched.filter((m) => m.outcome === "errored").length;
	const judged = matched.length - erroredRows;
	const targetUsageReported = matched.some(
		(m) => (m.row.cost ?? 0) > 0 || (m.row.tokenUsage?.total ?? 0) > 0,
	);
	return {
		generatedAt: args.now.toISOString(),
		promptfooVersion: results.metadata?.promptfooVersion ?? null,
		rows: results.results.results.length,
		matched: matched.length,
		unmatched,
		passRate: judged === 0 ? 0 : round(passed / judged, 4),
		cases: caseRuns,
		failing: caseRuns
			.filter(notPassingCleanly)
			.map((c) => `${c.case} @ ${c.model}`),
		flaky: caseRuns
			.filter((c) => c.stability === "flaky")
			.map((c) => `${c.case} @ ${c.model}`),
		scenarios: scenarioStats,
		coverage: {
			reviewedScenarios: reviewedScenarios.length,
			withRuns: scenarioStats.filter((s) => s.run > 0).length,
			withoutCase: reviewedScenarios
				.filter((s) => !withCase.has(s.id))
				.map((s) => s.id),
		},
		disagreements: disagreementsOf(matched),
		costs: costsOf({ matched, prices, estimate, targetUsageReported }),
		targetUsageReported,
		baseline: baselineDiffOf(caseRuns, args.baseline),
	};
}
