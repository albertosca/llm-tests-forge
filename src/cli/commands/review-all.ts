import { join } from "node:path";
import { ForgeError } from "../../core/errors";
import { forgePaths, writeCases } from "../../core/files";
import { expectedMatchesOracle } from "../../core/oracle";
import { applyDecision } from "../../core/review";
import type { Case, Feature, Scenario } from "../../core/schemas";

export interface ReviewAllArgs {
	/** The scenario named by `--scenario`, as read off disk. */
	scenario: Scenario;
	/** The scenario's cases file as the caller read it — read once, before the twin-id warning, for both paths. */
	cases: Case[];
	feature: Feature;
	forgeDir: string;
	stdout: (line: string) => void;
}

/**
 * `llm-tests-forge review --scenario <id> --all`: bulk-approves every pending case of
 * one scenario, without a prompt. It is for someone who already read the
 * file, not a way around the oracle contract every other path enforces —
 * a case whose `expected` the scenario's oracle does not accept is left
 * pending and named, and so is one with no `expected` at all.
 */
export async function reviewAllCommand(args: ReviewAllArgs): Promise<void> {
	const { scenario, cases, feature, forgeDir, stdout } = args;
	const id = scenario.id;
	// The file is named for the scenario its cases belong to, and that is
	// the scenario whose oracle `--all` approves them against. A
	// hand-edited file holding a case that names another scenario was
	// bulk-approved here against an oracle that is not its own. Checked
	// before anything is written, so a bad file comes back exactly as it
	// went in rather than half-approved — and only for the pending cases
	// this path would approve, as the interactive path refuses only what
	// it offers: an approved entry nobody touches does not block the pass.
	const file = join(forgePaths(forgeDir).casesDir, `${id}.yaml`);
	for (const c of cases)
		if (c.status === "pending" && c.scenario !== id)
			throw new ForgeError(
				`case ${c.id} names scenario "${c.scenario}" but lives in ${file}; run \`llm-tests-forge move --case ${c.id} --to ${c.scenario}\` or fix the file`,
				{ file, id: c.id },
			);

	let approved = 0;
	let noExpected = 0;
	let offOracle = 0;
	const updated = cases.map((c) => {
		if (c.status !== "pending") return c;
		if (c.expected === undefined) {
			noExpected += 1;
			return c;
		}
		const problem = expectedMatchesOracle(c.expected, scenario.oracle, feature);
		if (problem !== null) {
			offOracle += 1;
			stdout(`review: ${c.id}: ${problem}`);
			return c;
		}
		approved += 1;
		return applyDecision(c, "approve");
	});
	if (approved > 0) await writeCases(forgeDir, id, updated);

	const notes: string[] = [];
	if (noExpected > 0)
		notes.push(
			`${noExpected} left pending (no expected set — run \`llm-tests-forge review --scenario ${id}\` to fill them in)`,
		);
	if (offOracle > 0)
		notes.push(
			`${offOracle} left pending (expected does not match the ${scenario.oracle} oracle — see above)`,
		);
	stdout(
		`review: approved ${approved} pending case(s) of ${id}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
	);
}
