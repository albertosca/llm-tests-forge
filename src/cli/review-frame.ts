import { stringify } from "yaml";
import type { PendingItem } from "../core/review";
import type { Feature, Scenario } from "../core/schemas";

/** Where an item sits in the pass; `position` is 1-based. */
export interface Place {
	position: number;
	total: number;
}

export interface FrameContext {
	feature: Feature;
	scenarios: Scenario[];
}

/**
 * The explanatory lines around an item: `before` goes under the header,
 * the item's own YAML follows only when `showYaml`, then `after`.
 */
export interface Frame {
	before: string[];
	showYaml: boolean;
	after: string[];
}

const ORACLE_MEANING: Record<Scenario["oracle"], string> = {
	label: "the answer must come out as this label",
	fields: "the answer's fields must match these values",
	rubric:
		"a judge model grades the answer against this sentence (free text, no fixed labels)",
};

const KIND_MEANING: Record<Scenario["kind"], string> = {
	happy: "a typical, clear input",
	edge: "an unusual or extreme input, such as empty, very long or oddly formatted",
	ambiguous: "an input that can reasonably be read two ways",
	out_of_scope: "an input the feature is not meant to handle",
	adversarial: "an input that tries to trick or break the app",
	language: "an input in another language or register",
};

const KEYS_LINE: Record<PendingItem["kind"], string> = {
	case: "approve = this expected answer is right for this input · reject = drop this case · edit = fix it · skip = decide later",
	scenario:
		"approve = keep this scenario · reject = drop it · edit = change it · skip = decide later",
	feature:
		"approve = this description is right · reject = drop it · edit = change it · skip = decide later",
};

const SHARED_KEYS =
	"keys: a approve · r reject · e edit · s skip (Enter asks before skipping)";

function indentedYaml(value: unknown): string[] {
	return stringify(value, { lineWidth: 0 })
		.trimEnd()
		.split("\n")
		.map((line) => (line === "" ? line : `  ${line}`));
}

/**
 * A line of prose with a prefix. Text that comes from a file can hold line
 * breaks; its later lines are indented so none of them can start at column 0,
 * where a line like `--- case x ---` would read as a header.
 */
function prose(prefix: string, text: string): string[] {
	// Stryker disable next-line StringLiteral: `split` always returns at least one element, so the default is never read.
	const [first = "", ...rest] = text.split("\n");
	return [`${prefix}${first}`, ...rest.map((line) => `  ${line}`)];
}

function checkedAs(oracle: Scenario["oracle"]): string {
	return `Checked as ${oracle}: ${ORACLE_MEANING[oracle]}`;
}

export function frameFor(
	pending: PendingItem,
	place: Place,
	context: FrameContext,
): Frame {
	const position = `Item ${place.position} of ${place.total}`;
	const after = [KEYS_LINE[pending.kind], SHARED_KEYS];
	if (pending.kind === "feature")
		return { before: [`${position} · the feature`], showYaml: true, after };
	if (pending.kind === "scenario") {
		const { kind, oracle } = pending.item;
		return {
			before: [
				`${position} · a scenario (kind: ${kind}, ${KIND_MEANING[kind]})`,
				checkedAs(oracle),
			],
			showYaml: true,
			after,
		};
	}

	const kase = pending.item;
	const scenario = context.scenarios.find(
		(candidate) => candidate.id === kase.scenario,
	);
	const labels = context.feature.output.labels ?? [];
	const before = [`${position} · a case of scenario "${kase.scenario}"`];
	if (scenario) before.push(...prose("Scenario: ", scenario.description));
	before.push("Input:", ...indentedYaml(kase.input));
	if (kase.expected)
		before.push(
			`Expected, proposed by ${kase.generated_by} (you confirm or correct it):`,
			...indentedYaml(kase.expected),
		);
	else before.push("Expected: none yet; approve or edit will ask you for it.");
	if (scenario) before.push(checkedAs(scenario.oracle));
	if (scenario?.oracle === "label" && labels.length > 0)
		before.push(
			`Valid labels: ${labels.join(", ")}`,
			...Object.entries(context.feature.output.label_notes ?? {}).flatMap(
				([name, note]) => prose(`  • ${name}: `, note),
			),
		);
	if (context.feature.invariants.length > 0)
		before.push(
			"Rules the answer must respect (the feature's invariants):",
			"How these rules are used: the model that proposes cases is given them; check that the Expected follows them.",
			...context.feature.invariants.flatMap((rule) => prose("  • ", rule)),
		);
	if (kase.duplicate_of)
		before.push(
			`Note: looks like a near-duplicate of ${kase.duplicate_of} (flagged by the duplicate check). Reject to drop this one, approve to keep both.`,
		);
	return { before, showYaml: false, after };
}

/**
 * Said once, before the first item of a pass that holds a case: a boxed
 * block with a bar down the left side, a title and one bullet per idea. The
 * first line is the title.
 */
export function passPreface(): string[] {
	return [
		"┃ READ THIS FIRST: what you are doing in this review",
		"┃",
		"┃  • You are setting the right answer for each case. Nothing has run yet.",
		"┃  • A scenario is a situation worth testing; a case is one concrete Input inside it.",
		"┃  • Later, `promptfoo eval` sends each Input to your app and checks the app's answer against the Expected you approve here.",
		"┃  • Each scenario is checked one way: by label, fields or rubric. So one case shows a label and another a rubric; it follows its scenario, never both.",
		"┃  • Approve what is correct, edit what is wrong, reject what should not be tested.",
		"",
	];
}

export interface NextStepState {
	stillPending: number;
	scenarios: Scenario[];
	scenarioIdsWithCases: Set<string>;
	/** Cases that will reach the suite: approved or edited. */
	approvedCaseCount: number;
	/** The `--scenario` this pass was limited to, so the next command keeps it. */
	scenarioId?: string;
}

/** The one line that closes a pass: what to run next, given what exists. */
export function nextStep(state: NextStepState): string {
	const scopeFlag =
		state.scenarioId === undefined ? "" : ` --scenario ${state.scenarioId}`;
	if (state.stillPending > 0)
		return `Next: ${state.stillPending} item(s) still pending: run llm-tests-forge review${scopeFlag} again.`;
	const usable = state.scenarios.filter(
		(scenario) =>
			scenario.status === "approved" || scenario.status === "edited",
	);
	if (usable.length === 0) return "Next: run llm-tests-forge scenarios.";
	const needsCases =
		state.approvedCaseCount === 0 ||
		usable.some((scenario) => !state.scenarioIdsWithCases.has(scenario.id));
	return needsCases
		? `Next: run llm-tests-forge cases${scopeFlag}.`
		: "Next: run llm-tests-forge estimate, then emit.";
}

export interface SummaryCounts {
	skipped: number;
	stillPending: number;
	reopened: number;
}

/**
 * Plain words for the counts on the summary line, said only for the counts
 * that are not zero: the line itself stays one stable line.
 */
export function summaryLegend(counts: SummaryCounts): string[] {
	const lines: string[] = [];
	if (counts.skipped > 0)
		lines.push(
			"skipped: you chose to decide later; the item stays pending, untouched.",
		);
	if (counts.reopened > 0)
		lines.push(
			"re-opened: approved cases sent back to pending because their scenario's way of being checked changed; they count as pending.",
		);
	if (counts.stillPending > 0)
		lines.push(
			"still pending: everything not decided yet, the skipped items included, plus anything this pass did not offer (--only leaves the other kinds out).",
		);
	return lines.length > 0 ? ["How to read the counts below:", ...lines] : [];
}
