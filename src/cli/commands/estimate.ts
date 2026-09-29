import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError } from "../../core/errors";
import {
	approxTokens,
	estimateSuite,
	renderEstimate,
} from "../../core/estimate";
import {
	forgePaths,
	readAllCases,
	readFailure,
	readFeature,
	readScenarios,
	readSuite,
} from "../../core/files";
import { selectCases } from "../../core/select";
import { loadPrices } from "../../llm/prices";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";

/**
 * `feature.prompt_file` is relative to the application root (the parent of
 * `.forge/`), which is where `describe --prompt-file` resolved it from --
 * unless it is itself absolute, in which case `resolve` (unlike `join`)
 * leaves it untouched rather than mangling it under the application root.
 * A file that is named but cannot be read is an error, not a zero: a zero
 * here would silently understate every target line, and the OS's own
 * reason (missing, a directory, unreadable) is worth keeping rather than
 * flattening every cause into "not readable".
 */
export async function promptTokensFor(
	forgeDirectory: string,
	promptFile: string | undefined,
): Promise<number> {
	if (promptFile === undefined) return 0;
	const path = resolve(forgeDirectory, "..", promptFile);
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		throw new ForgeError(`prompt_file ${readFailure(error)}`, { file: path });
	});
	return approxTokens(text);
}

export async function estimateCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	parseArgs({ args: commandArguments, options: {} });
	const paths = forgePaths(context.forgeDirectory);
	const feature = await readFeature(context.forgeDirectory);
	requireApprovedFeature(feature, paths.feature);
	const suite = await readSuite(
		context.forgeDirectory,
		context.project?.config.language,
	);
	const selection = selectCases({
		suite,
		scenarios: await readScenarios(context.forgeDirectory),
		casesByScenario: await readAllCases(context.forgeDirectory),
		paths,
		feature,
	});
	// An all-zero table is not an estimate of anything: it reads as "this
	// run is free" when it means "this run has nothing in it".
	if (selection.cases.length === 0)
		throw new ForgeError(
			"no approved case to estimate; run `llm-tests-forge review` first",
			{ file: paths.casesDir },
		);
	const estimate = estimateSuite({
		suite,
		selection,
		feature,
		prices: await loadPrices(),
		promptTokens: await promptTokensFor(
			context.forgeDirectory,
			feature.prompt_file,
		),
	});
	context.stdout(renderEstimate(estimate));
	if (selection.blockers.length > 0) {
		const count = selection.blockers.length;
		// Same rule as `emit`: a rejected item was already decided, so
		// pointing at `llm-tests-forge review` for it would be wrong advice.
		const hint =
			selection.reviewable > 0
				? `; run \`llm-tests-forge review\` to include ${count === 1 ? "it" : "them"}`
				: "";
		context.stdout(
			`estimate: ${count} item${count === 1 ? "" : "s"} excluded${hint}:`,
		);
		for (const blocker of selection.blockers) context.stdout(`  ${blocker}`);
	}
}
