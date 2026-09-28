import { type CaseRun, notPassingCleanly, type Report } from "../core/report";

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
const signed = (amount: number): string =>
	`${amount >= 0 ? "+" : ""}${amount.toFixed(1)}%`;

function table(header: string[], rows: string[][]): string[] {
	return [row(header), rule(header.length), ...rows.map(row)];
}

function headline(report: Report): string {
	const runs = report.cases.reduce((total, caseRun) => total + caseRun.runs, 0);
	const passed = report.cases.reduce(
		(total, caseRun) => total + caseRun.passed,
		0,
	);
	const errored = report.cases.reduce(
		(total, caseRun) => total + caseRun.errored,
		0,
	);
	const parts = [
		`**Pass rate:** ${percent(report.passRate)} (${passed} of ${runs} runs, ${errored} errored)`,
		`**failing or errored:** ${report.failing.length}`,
		`**flaky:** ${report.flaky.length}`,
		`**judge disagreements:** ${report.disagreements.length}`,
	];
	if (report.baseline)
		parts.push(
			`**regressions since baseline:** ${report.baseline.regressions.length}`,
		);
	return parts.join(" · ");
}

function regressions(report: Report): string[] {
	if (!report.baseline) return [];
	const out = ["## Regressions since baseline", ""];
	if (report.baseline.regressions.length === 0)
		out.push("No regression since baseline.");
	else
		out.push(
			...table(
				["case", "model", "before", "after"],
				report.baseline.regressions.map((entry) => [
					entry.case,
					entry.model,
					entry.before,
					entry.after,
				]),
			),
		);
	out.push("", `Fixed since baseline: ${report.baseline.fixed.length}.`, "");
	// Why the two lists above may be empty: a renamed pair is compared to
	// nothing, and "0 regressions" alone read as "nothing changed".
	if (report.baseline.onlyInBaseline.length > 0)
		out.push(
			`Not in this run, so not compared: ${report.baseline.onlyInBaseline.length} baseline pair(s) — ${report.baseline.onlyInBaseline.map((pair) => `${pair.case} @ ${pair.model}`).join(", ")}.`,
			"",
		);
	return out;
}

const caseRow = (caseRun: CaseRun): string[] => [
	caseRun.case,
	caseRun.model,
	String(caseRun.runs),
	String(caseRun.passed),
	String(caseRun.failed),
	String(caseRun.errored),
	caseRun.reasons.join("; "),
];

/**
 * Failing and flaky read the same way, so they are the same table twice: a
 * case that never passed is the first thing to look at, and a report that
 * only listed the flaky ones left it to be found by reading a per-scenario
 * count.
 *
 * The rows are picked by stability rather than by looking each `CaseRun` up
 * in `report.failing`/`report.flaky`: those lists hold the display string
 * `"<case> @ <model>"`, which two different pairs can spell the same way
 * when a case id contains ` @ `. The lists stay as the JSON summary.
 */
function caseSection(parameters: {
	title: string;
	empty: string;
	pick: (caseRun: CaseRun) => boolean;
	report: Report;
}): string[] {
	const { title, empty, pick, report } = parameters;
	const out = [`## ${title}`, ""];
	const runs = report.cases.filter(pick);
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

function disagreement(report: Report): string[] {
	const out = ["## Judge disagreement", ""];
	if (report.disagreements.length === 0) {
		out.push("No disagreement.", "");
		return out;
	}
	const columns = Math.max(
		...report.disagreements.map((entry) => entry.judges.length),
	);
	// "disagreeing runs", not "runs": every other table in the report counts
	// how often the pair ran, and this column counts only the runs the
	// judges split on — the same word for two different numbers.
	const header = [
		"case",
		"model",
		"disagreeing runs",
		...Array.from({ length: columns }, (_, index) => `judge ${index + 1}`),
	];
	out.push(
		...table(
			header,
			report.disagreements.map((entry) => {
				const cells = entry.judges.map(
					(judgeVerdict) =>
						`${judgeVerdict.judge}: ${judgeVerdict.pass ? "pass" : "fail"} — ${judgeVerdict.reason}`,
				);
				while (cells.length < columns) cells.push("");
				return [entry.case, entry.model, String(entry.occurrences), ...cells];
			}),
		),
	);
	out.push("");
	return out;
}

function perScenario(report: Report): string[] {
	const coverage = `Coverage: ${report.coverage.withRuns} of ${report.coverage.reviewedScenarios} reviewed scenarios ran`;
	return [
		"## Per scenario",
		"",
		...table(
			["scenario", "kind", "runs", "passed", "failed", "errored"],
			report.scenarios.map((scenarioStat) => [
				scenarioStat.scenario,
				scenarioStat.kind,
				String(scenarioStat.run),
				String(scenarioStat.passed),
				String(scenarioStat.failed),
				String(scenarioStat.errored),
			]),
		),
		"",
		coverageSentence(report, coverage),
		"",
	];
}

/**
 * The README promises to say which reviewed scenarios never ran. A scenario
 * with no case, one with cases but no matched row, and one the suite's
 * `include` left out entirely are three different things to do next, so
 * they are three clauses.
 */
function coverageSentence(report: Report, coverage: string): string {
	const clauses = [
		report.coverage.withoutCase.length === 0
			? null
			: `no case yet: ${report.coverage.withoutCase.join(", ")}`,
		report.coverage.withoutRun.length === 0
			? null
			: `no matched run: ${report.coverage.withoutRun.join(", ")}`,
		report.coverage.notSelected.length === 0
			? null
			: `not in this suite: ${report.coverage.notSelected.join(", ")}`,
	].filter((clause) => clause !== null);
	return clauses.length === 0
		? `${coverage}.`
		: `${coverage}; ${clauses.join("; ")}`;
}

/**
 * Only worth a section when there is something to compare: with one target
 * model the stability column is already in every other table.
 */
function perModel(report: Report): string[] {
	if (
		report.costs.filter((modelCost) => modelCost.role === "target").length < 2
	)
		return [];
	const models = [...new Set(report.cases.map((caseRun) => caseRun.model))];
	const cases = [...new Set(report.cases.map((caseRun) => caseRun.case))];
	const stability = new Map(
		report.cases.map((caseRun) => [
			JSON.stringify([caseRun.model, caseRun.case]),
			caseRun.stability,
		]),
	);
	return [
		"## Per model",
		"",
		...table(
			["case", ...models],
			cases.map((id) => [
				id,
				...models.map(
					(model) => stability.get(JSON.stringify([model, id])) ?? NONE,
				),
			]),
		),
		"",
	];
}

function cost(report: Report): string[] {
	const out = [
		"## Cost",
		"",
		...table(
			["model", "role", "input", "output", "real", "estimated", "error"],
			report.costs.map((modelCost) => [
				`${modelCost.model}${modelCost.approximatePrice ? " ~" : ""}`,
				modelCost.role,
				String(modelCost.inputTokens),
				String(modelCost.outputTokens),
				modelCost.realDollars === null ? NONE : money(modelCost.realDollars),
				modelCost.estimatedDollars === null
					? NONE
					: money(modelCost.estimatedDollars),
				modelCost.errorPercent === null ? NONE : signed(modelCost.errorPercent),
			]),
		),
		"",
	];
	if (report.costs.some((modelCost) => modelCost.approximatePrice))
		out.push(
			"~ marks a model priced as the closest listed model in prices.yaml.",
			"",
		);
	out.push(
		report.targetUsageReported
			? "Target usage: reported by the shim."
			: "Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table",
		"",
	);
	return out;
}

function unmatched(report: Report): string[] {
	if (report.unmatched.length === 0) return [];
	return [
		"## Unmatched rows",
		"",
		...report.unmatched.map((unmatchedRow) => `- ${cell(unmatchedRow)}`),
		"",
	];
}

/**
 * The decisive numbers first, then one section per question the person
 * actually asks of a run: what broke since last time, what is unstable,
 * where the judges disagree, what the suite covers, and what it cost.
 */
export function renderReportMarkdown(report: Report): string {
	return [
		`# forge report — ${report.generatedAt}`,
		"",
		headline(report),
		"",
		...regressions(report),
		...caseSection({
			title: "Failing or errored cases",
			empty: "No failing or errored case.",
			pick: notPassingCleanly,
			report,
		}),
		...caseSection({
			title: "Flaky cases",
			empty: "No flaky case.",
			pick: (caseRun) => caseRun.stability === "flaky",
			report,
		}),
		...disagreement(report),
		...perScenario(report),
		...perModel(report),
		...cost(report),
		...unmatched(report),
	].join("\n");
}
