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

/**
 * `report --baseline` prints its regression count and exits 0 either way, so
 * the verdict is read back from the report it wrote.
 */
export function regressionsIn(reportJson: string): number {
	const report = JSON.parse(reportJson) as {
		baseline?: { regressions?: unknown[] };
	};
	return report.baseline?.regressions?.length ?? 0;
}

/**
 * promptfoo exits 100 when the eval ran and some rows failed. That is a
 * verdict for the report's baseline comparison, not a broken step; any other
 * non-zero code (crash, bad config) still stops the run.
 */
export function evalRan(exitCode: number): boolean {
	return exitCode === 0 || exitCode === 100;
}
