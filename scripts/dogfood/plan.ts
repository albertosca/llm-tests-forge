import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";

/** The features to run: all of them, or the ones named, refusing a name that is not a feature. */
export function selectFeatures(
	available: string[],
	requested: string[],
): string[] {
	const sorted = [...available].sort();
	for (const name of requested)
		if (!sorted.includes(name))
			throw new ForgeError(
				`unknown dogfood feature "${name}"; known: ${sorted.join(", ")}`,
			);
	return requested.length === 0
		? sorted
		: sorted.filter((name) => requested.includes(name));
}

/** The `stamp.minimum_pass_rate` a suite declares, or a refusal when it declares none. */
export function minimumPassRateOf(suiteYaml: string): number {
	const rate = (
		parse(suiteYaml) as { stamp?: { minimum_pass_rate?: unknown } } | null
	)?.stamp?.minimum_pass_rate;
	if (typeof rate !== "number")
		throw new ForgeError("suite.yaml has no stamp.minimum_pass_rate");
	return rate;
}

/**
 * What is wrong with a finished run, read back from the report it wrote:
 * `report --baseline` prints its findings and exits 0 either way, so the
 * verdict is made here. A baseline pair missing from the run counts as much
 * as a pair that got worse (deleting a failing case must not turn the run
 * green), and a run under the suite's own minimum pass rate fails even when
 * nothing regressed. Empty means clean.
 */
export function problemsIn(
	reportJson: string,
	minimumPassRate: number,
): string[] {
	const report = JSON.parse(reportJson) as {
		passRate?: number;
		baseline?: { regressions?: unknown[]; onlyInBaseline?: unknown[] };
	};
	const problems: string[] = [];
	const regressions = report.baseline?.regressions?.length ?? 0;
	if (regressions > 0) problems.push(`${regressions} regressions`);
	const dropped = report.baseline?.onlyInBaseline?.length ?? 0;
	if (dropped > 0)
		problems.push(`${dropped} baseline pairs are missing from this run`);
	if (typeof report.passRate === "number" && report.passRate < minimumPassRate)
		problems.push(
			`pass rate ${report.passRate} is under the suite's minimum ${minimumPassRate}`,
		);
	return problems;
}

/**
 * promptfoo exits 100 when the eval ran and some rows failed. That is a
 * verdict for the report's baseline comparison, not a broken step; any other
 * non-zero code (crash, bad config) still stops the run.
 */
export function evalRan(exitCode: number): boolean {
	return exitCode === 0 || exitCode === 100;
}
