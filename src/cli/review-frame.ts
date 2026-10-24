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
	rubric: "a judge model grades the answer against this sentence",
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
		.map((line) => `  ${line}`);
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
				`${position} · a scenario (kind: ${kind}, oracle: ${oracle})`,
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
	if (scenario) before.push(`Scenario: ${scenario.description}`);
	before.push("Input:", ...indentedYaml(kase.input));
	if (kase.expected)
		before.push(
			`Expected, proposed by ${kase.generated_by} (you confirm or correct it):`,
			...indentedYaml(kase.expected),
		);
	else before.push("Expected: none yet; approve or edit will ask you for it.");
	if (scenario) before.push(checkedAs(scenario.oracle));
	if (scenario?.oracle === "label" && labels.length > 0)
		before.push(`Valid labels: ${labels.join(", ")}`);
	if (kase.duplicate_of)
		before.push(
			`Note: looks like a near-duplicate of ${kase.duplicate_of} (flagged by dedupe). Reject to drop this one, approve to keep both.`,
		);
	return { before, showYaml: false, after };
}

export interface NextStepState {
	stillPending: number;
	scenarios: Scenario[];
	scenarioIdsWithCases: Set<string>;
	/** Cases that will reach the suite: approved or edited. */
	approvedCaseCount: number;
}

/** The one line that closes a pass: what to run next, given what exists. */
export function nextStep(state: NextStepState): string {
	if (state.stillPending > 0)
		return `Next: ${state.stillPending} item(s) still pending: run llm-tests-forge review again.`;
	const usable = state.scenarios.filter(
		(scenario) =>
			scenario.status === "approved" || scenario.status === "edited",
	);
	if (usable.length === 0) return "Next: run llm-tests-forge scenarios.";
	const needsCases =
		state.approvedCaseCount === 0 ||
		usable.some((scenario) => !state.scenarioIdsWithCases.has(scenario.id));
	return needsCases
		? "Next: run llm-tests-forge cases."
		: "Next: run llm-tests-forge estimate, then emit.";
}
