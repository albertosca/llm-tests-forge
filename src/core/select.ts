import { join } from "node:path";
import { ForgeError } from "./errors";
import type { ForgePaths } from "./files";
import type { Case, Scenario, Suite } from "./schemas";

export interface Selection {
	/** Included scenarios that are approved or edited, in include (or file) order. */
	scenarios: Scenario[];
	/** Selected cases, scenario order then file order. */
	cases: Case[];
	/** One sentence per item that keeps the suite from being emitted. */
	blockers: string[];
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
}): Selection {
	const { suite, scenarios, casesByScenario, paths } = args;
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
		wanted = scenarios.filter((s) => reviewed(s.status));
	}
	const blockers: string[] = [];
	const selectedScenarios: Scenario[] = [];
	const cases: Case[] = [];
	for (const s of wanted) {
		if (!reviewed(s.status)) {
			blockers.push(`scenario ${s.id} is ${s.status} (${paths.scenarios})`);
			continue;
		}
		selectedScenarios.push(s);
		const file = join(paths.casesDir, `${s.id}.yaml`);
		for (const c of casesByScenario.get(s.id) ?? []) {
			if (c.status === "pending") {
				blockers.push(`case ${c.id} is pending (${file})`);
				continue;
			}
			if (c.status === "rejected") continue;
			if (c.expected === undefined) {
				blockers.push(`case ${c.id} has no expected (${file})`);
				continue;
			}
			cases.push(c);
		}
	}
	return { scenarios: selectedScenarios, cases, blockers };
}
