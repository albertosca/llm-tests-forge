import { join } from "node:path";
import { ForgeError } from "./errors";
import type { ForgePaths } from "./files";
import { expectedMatchesOracle } from "./oracle";
import type { Case, Feature, Scenario, Suite } from "./schemas";

export interface Selection {
	/** Included scenarios that are approved or edited, in include (or file) order. */
	scenarios: Scenario[];
	/** Selected cases, scenario order then file order. */
	cases: Case[];
	/** One sentence per item that keeps the suite from being emitted. */
	blockers: string[];
	/**
	 * How many of `blockers` the person can still clear at the review
	 * prompt. A rejected item is not one of them — it is a decision already
	 * taken — so a caller that tells the person to run `llm-tests-forge review` asks
	 * this rather than the length of `blockers`.
	 */
	reviewable: number;
}

/** The keys a case's input lacks and has beyond the feature's inputs, as `missing: …; extra: …`, or null when they are the same set. */
function inputKeyMismatch(
	input: Record<string, string>,
	feature: Feature,
): string | null {
	const names = feature.inputs.map((featureInput) => featureInput.name);
	const keys = Object.keys(input);
	const missing = names.filter((name) => !keys.includes(name));
	const extra = keys.filter((key) => !names.includes(key));
	if (missing.length === 0 && extra.length === 0) return null;
	const listed = (items: string[]): string =>
		items.length > 0 ? items.join(", ") : "none";
	return `missing: ${listed(missing)}; extra: ${listed(extra)}`;
}

function reviewed(status: Scenario["status"]): boolean {
	return status === "approved" || status === "edited";
}

/**
 * The one answer to "which cases does this suite run?" — `estimate`, `emit`
 * and `report` all ask it here so they cannot disagree. A blocker is an item
 * the person still owes a decision on; a rejected case is not one, it is a
 * decision already taken.
 */
export function selectCases(request: {
	suite: Suite;
	scenarios: Scenario[];
	casesByScenario: Map<string, Case[]>;
	paths: ForgePaths;
	feature: Feature;
}): Selection {
	const { suite, scenarios, casesByScenario, paths, feature } = request;
	let wanted: Scenario[];
	if (suite.include.length > 0) {
		wanted = suite.include.map((id) => {
			const included = scenarios.find((candidate) => candidate.id === id);
			if (!included)
				throw new ForgeError(`scenario "${id}" in suite.include not found`, {
					file: paths.suite,
					id,
				});
			return included;
		});
	} else {
		// Pending scenarios are walked, not filtered away: one of them can
		// already hold approved cases, and dropping the pair in silence is
		// how a suite runs a case short without anyone being told.
		wanted = scenarios.filter(
			(scenario) => reviewed(scenario.status) || scenario.status === "pending",
		);
	}
	const blockers: string[] = [];
	let reviewable = 0;
	const block = (sentence: string, canReview: boolean): void => {
		blockers.push(sentence);
		if (canReview) reviewable += 1;
	};
	const selectedScenarios: Scenario[] = [];
	const cases: Case[] = [];
	for (const scenario of wanted) {
		if (!reviewed(scenario.status)) {
			block(
				`scenario ${scenario.id} is ${scenario.status} (${paths.scenarios})`,
				scenario.status === "pending",
			);
			continue;
		}
		selectedScenarios.push(scenario);
		const file = join(paths.casesDir, `${scenario.id}.yaml`);
		for (const kase of casesByScenario.get(scenario.id) ?? []) {
			if (kase.status === "pending") {
				block(`case ${kase.id} is pending (${file})`, true);
				continue;
			}
			if (kase.status === "rejected") continue;
			// An input renamed in feature.yaml alone left every case with the
			// old key: the prompt then named a var no case had, and the
			// target received "" in silence. Refused, not a blocker: review
			// cannot fix it, a rename in one of the two files does.
			const keyMismatch = inputKeyMismatch(kase.input, feature);
			if (keyMismatch !== null)
				throw new ForgeError(
					`case ${kase.id}'s input keys do not match the feature's inputs (${keyMismatch}); rename them in its input: or in feature.yaml`,
					{ file, id: kase.id },
				);
			if (kase.expected === undefined) {
				block(`case ${kase.id} has no expected (${file})`, true);
				continue;
			}
			// A case is approved against the oracle its scenario had that
			// day; editing the scenario's oracle afterwards leaves the pair
			// mismatched, and emitting it would write an assert that checks
			// nothing. The person is sent back to review instead.
			const mismatch = expectedMatchesOracle(
				kase.expected,
				scenario.oracle,
				feature,
			);
			if (mismatch !== null) {
				block(`case ${kase.id}: ${mismatch} (${file})`, true);
				continue;
			}
			cases.push(kase);
		}
	}
	return { scenarios: selectedScenarios, cases, blockers, reviewable };
}
