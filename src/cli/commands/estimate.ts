import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
 * `.forge/`), which is where `describe --prompt-file` resolved it from. A
 * file that is named but cannot be read is an error, not a zero: a zero
 * here would silently understate every target line.
 */
export async function promptTokensFor(
	forgeDir: string,
	promptFile: string | undefined,
): Promise<number> {
	if (promptFile === undefined) return 0;
	const path = join(forgeDir, "..", promptFile);
	const text = await readFile(path, "utf8").catch(() => {
		throw new ForgeError("prompt_file not readable", { file: path });
	});
	return approxTokens(text);
}

export async function estimateCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	parseArgs({ args, options: {} });
	const paths = forgePaths(ctx.forgeDir);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	const suite = await readSuite(ctx.forgeDir);
	const selection = selectCases({
		suite,
		scenarios: await readScenarios(ctx.forgeDir),
		casesByScenario: await readAllCases(ctx.forgeDir),
		paths,
	});
	const estimate = estimateSuite({
		suite,
		selection,
		feature,
		prices: await loadPrices(),
		promptTokens: await promptTokensFor(ctx.forgeDir, feature.prompt_file),
	});
	ctx.stdout(renderEstimate(estimate));
	if (selection.blockers.length > 0) {
		const n = selection.blockers.length;
		ctx.stdout(
			`estimate: ${n} pending item${n === 1 ? "" : "s"} excluded; run \`forge review\` to include ${n === 1 ? "it" : "them"}:`,
		);
		for (const b of selection.blockers) ctx.stdout(`  ${b}`);
	}
}
