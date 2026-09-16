import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import { estimateSuite } from "../../core/estimate";
import {
	forgePaths,
	readAllCases,
	readFeature,
	readScenarios,
	readSuite,
} from "../../core/files";
import { buildReport, type Report, ReportSchema } from "../../core/report";
import { selectCases } from "../../core/select";
import { plural } from "../../core/text";
import { loadPrices } from "../../llm/prices";
import { renderReportMarkdown } from "../../report/markdown";
import { readResults } from "../../report/results";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";
import { promptTokensFor } from "./estimate";

/**
 * A baseline is just an earlier `report.json`, so it is validated by the
 * same schema the report is built from — a file that is not one names
 * itself rather than producing a report full of silent nulls.
 */
async function readBaseline(path: string): Promise<Report> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new ForgeError("baseline not found", { file: path });
	});
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new ForgeError(`invalid JSON: ${(e as Error).message}`, {
			file: path,
		});
	}
	const parsed = ReportSchema.safeParse(data);
	if (!parsed.success)
		throw new ForgeError(
			`is not a forge report: ${parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
			{ file: path },
		);
	return parsed.data;
}

export async function reportCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { baseline: { type: "string" } },
		allowPositionals: true,
	});
	const resultsPath = positionals[0];
	if (!resultsPath)
		throw new UsageError("report needs the path of promptfoo's results.json");
	const paths = forgePaths(ctx.forgeDir);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	const suite = await readSuite(ctx.forgeDir);
	const scenarios = await readScenarios(ctx.forgeDir);
	const casesByScenario = await readAllCases(ctx.forgeDir);
	const prices = await loadPrices();
	const allCases = [...casesByScenario.values()].flat();
	const selection = selectCases({
		suite,
		scenarios,
		casesByScenario,
		paths,
		feature,
	});
	// The same selection `emit` used, so the estimate compared against is
	// the one the person saw before paying for the run.
	const estimate = estimateSuite({
		suite,
		selection,
		feature,
		prices,
		promptTokens: await promptTokensFor(ctx.forgeDir, feature.prompt_file),
	});
	const results = await readResults(resultsPath);
	// Checked against undefined, not truthiness: `--baseline ""` is a
	// mistake to name, not a flag to drop on the floor.
	const baseline =
		values.baseline === undefined ? null : await readBaseline(values.baseline);
	const report = buildReport({
		results,
		resultsPath,
		scenarios,
		cases: selection.cases,
		knownCases: allCases,
		estimate,
		prices,
		baseline,
		now: new Date(),
	});
	await writeFile(paths.reportMd, renderReportMarkdown(report), "utf8");
	await writeFile(
		paths.reportJson,
		`${JSON.stringify(report, null, 2)}\n`,
		"utf8",
	);
	ctx.stdout(
		`report: ${report.matched} of ${report.rows} rows matched; pass rate ${(report.passRate * 100).toFixed(1)}%; ${report.failing.length} failing or errored; ${report.flaky.length} flaky; ${plural(report.disagreements.length, "judge disagreement")}`,
	);
	if (report.baseline)
		ctx.stdout(
			`report: since baseline: ${report.baseline.regressions.length} regressions, ${report.baseline.fixed.length} fixed`,
		);
	ctx.stdout(`report: wrote ${paths.reportMd} and ${paths.reportJson}`);
}
