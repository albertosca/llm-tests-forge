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
	 * taken — so a caller that tells the person to run `forge review` asks
	 * this rather than the length of `blockers`.
	 */
	reviewable: number;
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
export function selectCases(args: {
	suite: Suite;
	scenarios: Scenario[];
	casesByScenario: Map<string, Case[]>;
	paths: ForgePaths;
	feature: Feature;
}): Selection {
	const { suite, scenarios, casesByScenario, paths, feature } = args;
	let wanted: Scenario[];
	if (suite.include.length > 0) {
		wanted = suite.include.map((id) => {
			const s = scenarios.find((x) => x.id === id);
			if (!s)
				throw new ForgeError(`scenario "${id}" in suite.include not found`, {
					file: paths.suite,
					id,
				});
			return s;
		});
	} else {
		// Pending scenarios are walked, not filtered away: one of them can
		// already hold approved cases, and dropping the pair in silence is
		// how a suite runs a case short without anyone being told.
		wanted = scenarios.filter(
			(s) => reviewed(s.status) || s.status === "pending",
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
	for (const s of wanted) {
		if (!reviewed(s.status)) {
			block(
				`scenario ${s.id} is ${s.status} (${paths.scenarios})`,
				s.status === "pending",
			);
			continue;
		}
		selectedScenarios.push(s);
		const file = join(paths.casesDir, `${s.id}.yaml`);
		for (const c of casesByScenario.get(s.id) ?? []) {
			if (c.status === "pending") {
				block(`case ${c.id} is pending (${file})`, true);
				continue;
			}
			if (c.status === "rejected") continue;
			if (c.expected === undefined) {
				block(`case ${c.id} has no expected (${file})`, true);
				continue;
			}
			// A case is approved against the oracle its scenario had that
			// day; editing the scenario's oracle afterwards leaves the pair
			// mismatched, and emitting it would write an assert that checks
			// nothing. The person is sent back to review instead.
			const mismatch = expectedMatchesOracle(c.expected, s.oracle, feature);
			if (mismatch !== null) {
				block(`case ${c.id}: ${mismatch} (${file})`, true);
				continue;
			}
			cases.push(c);
		}
	}
	return { scenarios: selectedScenarios, cases, blockers, reviewable };
}
