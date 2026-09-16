import type { CaseRun, Report } from "../core/report";

/** What a null reads as in a table cell. */
const NONE = "—";

/**
 * A judge writes prose, and prose contains `|` and newlines: either one
 * ends the cell early and shifts every column after it, which turns one
 * verbose reason into a table nobody can read. Applied to every cell rather
 * than to the fields known to be prose today.
 */
const cell = (text: string): string =>
	text.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");

const row = (cells: string[]): string => `| ${cells.map(cell).join(" | ")} |`;
const rule = (width: number): string =>
	row(Array.from({ length: width }, () => "---"));
const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;
const money = (dollars: number): string => `$${dollars.toFixed(6)}`;
const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function table(header: string[], rows: string[][]): string[] {
	return [row(header), rule(header.length), ...rows.map(row)];
}

function headline(r: Report): string {
	const runs = r.cases.reduce((n, c) => n + c.runs, 0);
	const passed = r.cases.reduce((n, c) => n + c.passed, 0);
	const errored = r.cases.reduce((n, c) => n + c.errored, 0);
	const parts = [
		`**Pass rate:** ${percent(r.passRate)} (${passed} of ${runs} runs, ${errored} errored)`,
		`**failing:** ${r.failing.length}`,
		`**flaky:** ${r.flaky.length}`,
		`**judge disagreements:** ${r.disagreements.length}`,
	];
	if (r.baseline)
		parts.push(
			`**regressions since baseline:** ${r.baseline.regressions.length}`,
		);
	return parts.join(" · ");
}

function regressions(r: Report): string[] {
	if (!r.baseline) return [];
	const out = ["## Regressions since baseline", ""];
	if (r.baseline.regressions.length === 0)
		out.push("No regression since baseline.");
	else
		out.push(
			...table(
				["case", "model", "before", "after"],
				r.baseline.regressions.map((d) => [d.case, d.model, d.before, d.after]),
			),
		);
	out.push("", `Fixed since baseline: ${r.baseline.fixed.length}.`, "");
	return out;
}

const caseRow = (c: CaseRun): string[] => [
	c.case,
	c.model,
	String(c.runs),
	String(c.passed),
	String(c.failed),
	String(c.errored),
	c.reasons.join("; "),
];

/**
 * Failing and flaky read the same way, so they are the same table twice: a
 * case that never passed is the first thing to look at, and a report that
 * only listed the flaky ones left it to be found by reading a per-scenario
 * count.
 */
function caseSection(args: {
	title: string;
	empty: string;
	keys: string[];
	report: Report;
}): string[] {
	const { title, empty, keys, report } = args;
	const out = [`## ${title}`, ""];
	const runs = report.cases.filter((c) =>
		keys.includes(`${c.case} @ ${c.model}`),
	);
	if (runs.length === 0) out.push(empty);
	else
		out.push(
			...table(
				["case", "model", "runs", "passed", "failed", "errored", "reasons"],
				runs.map(caseRow),
			),
		);
	out.push("");
	return out;
}

function disagreement(r: Report): string[] {
	const out = ["## Judge disagreement", ""];
	if (r.disagreements.length === 0) {
		out.push("No disagreement.", "");
		return out;
	}
	const columns = Math.max(...r.disagreements.map((d) => d.judges.length));
	const header = [
		"case",
		"model",
		...Array.from({ length: columns }, (_, i) => `judge ${i + 1}`),
	];
	out.push(
		...table(
			header,
			r.disagreements.map((d) => {
				const cells = d.judges.map(
					(j) => `${j.judge}: ${j.pass ? "pass" : "fail"} — ${j.reason}`,
				);
				while (cells.length < columns) cells.push("");
				return [d.case, d.model, ...cells];
			}),
		),
	);
	out.push("");
	return out;
}

function perScenario(r: Report): string[] {
	const coverage = `Coverage: ${r.coverage.withRuns} of ${r.coverage.approvedScenarios} approved scenarios ran`;
	return [
		"## Per scenario",
		"",
		...table(
			["scenario", "kind", "runs", "passed", "failed", "errored"],
			r.scenarios.map((s) => [
				s.scenario,
				s.kind,
				String(s.run),
				String(s.passed),
				String(s.failed),
				String(s.errored),
			]),
		),
		"",
		r.coverage.withoutCase.length === 0
			? `${coverage}.`
			: `${coverage}; no case yet: ${r.coverage.withoutCase.join(", ")}`,
		"",
	];
}

/**
 * Only worth a section when there is something to compare: with one target
 * model the stability column is already in every other table.
 */
function perModel(r: Report): string[] {
	if (r.costs.filter((c) => c.role === "target").length < 2) return [];
	const models = [...new Set(r.cases.map((c) => c.model))];
	const cases = [...new Set(r.cases.map((c) => c.case))];
	const stability = new Map(
		r.cases.map((c) => [JSON.stringify([c.model, c.case]), c.stability]),
	);
	return [
		"## Per model",
		"",
		...table(
			["case", ...models],
			cases.map((id) => [
				id,
				...models.map((m) => stability.get(JSON.stringify([m, id])) ?? NONE),
			]),
		),
		"",
	];
}

function cost(r: Report): string[] {
	const out = [
		"## Cost",
		"",
		...table(
			["model", "role", "input", "output", "real", "estimated", "error"],
			r.costs.map((c) => [
				`${c.model}${c.approximatePrice ? " ~" : ""}`,
				c.role,
				String(c.inputTokens),
				String(c.outputTokens),
				c.realDollars === null ? NONE : money(c.realDollars),
				c.estimatedDollars === null ? NONE : money(c.estimatedDollars),
				c.errorPercent === null ? NONE : signed(c.errorPercent),
			]),
		),
		"",
	];
	if (r.costs.some((c) => c.approximatePrice))
		out.push(
			"~ marks a model priced as the closest listed model in prices.yaml.",
			"",
		);
	out.push(
		r.targetUsageReported
			? "Target usage: reported by the shim."
			: "Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table",
		"",
	);
	return out;
}

function unmatched(r: Report): string[] {
	if (r.unmatched.length === 0) return [];
	return [
		"## Unmatched rows",
		"",
		...r.unmatched.map((u) => `- ${cell(u)}`),
		"",
	];
}

/**
 * The decisive numbers first, then one section per question the person
 * actually asks of a run: what broke since last time, what is unstable,
 * where the judges disagree, what the suite covers, and what it cost.
 */
export function renderReportMarkdown(r: Report): string {
	return [
		`# forge report — ${r.generatedAt}`,
		"",
		headline(r),
		"",
		...regressions(r),
		...caseSection({
			title: "Failing cases",
			empty: "No failing case.",
			keys: r.failing,
			report: r,
		}),
		...caseSection({
			title: "Flaky cases",
			empty: "No flaky case.",
			keys: r.flaky,
			report: r,
		}),
		...disagreement(r),
		...perScenario(r),
		...perModel(r),
		...cost(r),
		...unmatched(r),
	].join("\n");
}
