import { z } from "zod";
import { fromPromptfooProvider } from "../emit/providers";
import { priceFor } from "../llm/prices";
import type { PromptfooResults, PromptfooRow } from "../report/results";
import { ForgeError } from "./errors";
import type { Estimate } from "./estimate";
import type { Case, Prices, Scenario } from "./schemas";

export const StabilitySchema = z.enum([
	"stable",
	"flaky",
	"failing",
	"errored",
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
	realDollars: z.number(),
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
	/** Passed rows over matched rows, 0..1. */
	passRate: z.number(),
	/** One per (model, case): model name order, then the order of the cases files. */
	cases: z.array(CaseRunSchema),
	/** `"case @ model"` for every CaseRun whose stability is `flaky`. */
	flaky: z.array(z.string()),
	scenarios: z.array(ScenarioStatSchema),
	coverage: z.object({
		approvedScenarios: z.number(),
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

function modelOf(row: PromptfooRow): string {
	return row.provider.label ?? row.provider.id;
}

/**
 * An error is not a failure: a row that never reached the judge says
 * nothing about the case, so its `error` is the only reason worth
 * reporting and the two are counted apart everywhere below.
 */
function outcomeOf(row: PromptfooRow): { outcome: Outcome; reasons: string[] } {
	if (row.error) return { outcome: "errored", reasons: [row.error] };
	if (row.success) return { outcome: "passed", reasons: [] };
	const reasons: string[] = [];
	for (const c of row.gradingResult?.componentResults ?? [])
		if (!c.pass && c.reason !== undefined) reasons.push(c.reason);
	return { outcome: "failed", reasons };
}

function stabilityOf(runs: number, passed: number, errored: number): Stability {
	if (errored === runs) return "errored";
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

function matchRows(
	results: PromptfooResults,
	cases: Case[],
	resultsPath: string,
): { matched: MatchedRow[]; unmatched: string[] } {
	const caseById = new Map(cases.map((c) => [c.id, c]));
	const matched: MatchedRow[] = [];
	const unmatched: string[] = [];
	for (const row of results.results.results) {
		const id = row.metadata?.case;
		const kase = typeof id === "string" ? caseById.get(id) : undefined;
		if (kase) {
			matched.push({ row, kase, model: modelOf(row), ...outcomeOf(row) });
			continue;
		}
		const named = typeof id === "string" ? id : "no metadata.case";
		unmatched.push(`row ${row.testIdx}: ${modelOf(row)}: ${named}`);
	}
	if (matched.length === 0)
		throw new ForgeError(
			"no result matches a case in .forge/cases; was this results.json produced from a config forge emitted?",
			{ file: resultsPath },
		);
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
				stability: stabilityOf(entries.length, passed, errored),
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

/** One entry per matched row whose rubric judges did not all agree. */
function disagreementsOf(matched: MatchedRow[]): Disagreement[] {
	const out: Disagreement[] = [];
	for (const m of matched) {
		const judges = rubricComponents(m.row).map((c) => ({
			judge: judgeName(c.assertion?.provider),
			pass: c.pass,
			reason: c.reason ?? "",
		}));
		if (judges.length < 2) continue;
		if (new Set(judges.map((j) => j.pass)).size < 2) continue;
		out.push({ case: m.kase.id, model: m.model, judges });
	}
	return out;
}

function costLine(args: {
	model: string;
	role: "target" | "judge";
	inputTokens: number;
	outputTokens: number;
	realDollars: number;
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
		realDollars: round(realDollars, 6),
		estimatedDollars: line ? round(line.dollars, 6) : null,
		errorPercent:
			line && line.dollars > 0
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
}): ModelCost[] {
	const { matched, prices, estimate } = args;
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
				realDollars: reported
					? sum(mine, (m) => m.row.cost ?? 0)
					: (inputTokens * price.input + outputTokens * price.output) / 1e6,
				// `~` says "this dollar figure came from the closest listed
				// model". When promptfoo reported the cost itself no table
				// lookup happened, so marking it would be a lie.
				approximatePrice: reported ? false : price.approximate,
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
				realDollars:
					(totals.input * price.input + totals.output * price.output) / 1e6,
				approximatePrice: price.approximate,
				estimate,
			}),
		);
	}
	return costs;
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
	cases: Case[];
	estimate: Estimate | null;
	prices: Prices;
	baseline: Report | null;
	now: Date;
}): Report {
	const { results, resultsPath, scenarios, cases, estimate, prices } = args;
	const { matched, unmatched } = matchRows(results, cases, resultsPath);
	const caseRuns = caseRunsOf(matched, cases);
	const approved = scenarios.filter((s) => reviewed(s.status));
	const scenarioStats = scenarioStatsOf(matched, scenarios);
	const withCase = new Set(
		cases.filter((c) => reviewed(c.status)).map((c) => c.scenario),
	);
	return {
		generatedAt: args.now.toISOString(),
		promptfooVersion: results.metadata?.promptfooVersion ?? null,
		rows: results.results.results.length,
		matched: matched.length,
		unmatched,
		passRate: round(
			matched.filter((m) => m.outcome === "passed").length / matched.length,
			4,
		),
		cases: caseRuns,
		flaky: caseRuns
			.filter((c) => c.stability === "flaky")
			.map((c) => `${c.case} @ ${c.model}`),
		scenarios: scenarioStats,
		coverage: {
			approvedScenarios: approved.length,
			withRuns: scenarioStats.filter((s) => s.run > 0).length,
			withoutCase: approved.filter((s) => !withCase.has(s.id)).map((s) => s.id),
		},
		disagreements: disagreementsOf(matched),
		costs: costsOf({ matched, prices, estimate }),
		targetUsageReported: matched.some(
			(m) => (m.row.cost ?? 0) > 0 || (m.row.tokenUsage?.total ?? 0) > 0,
		),
		baseline: baselineDiffOf(caseRuns, args.baseline),
	};
}
