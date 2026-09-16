import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
	forgePaths,
	readCases,
	readFeature,
	readScenarios,
	writeCases,
	writeScenarios,
} from "../../core/files";
import { IMPORTED_SCENARIO_ID, importCases } from "../../core/import";
import { Oracle } from "../../core/schemas";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";

function parseOracleFlag(raw: string | undefined): Oracle | undefined {
	if (raw === undefined) return undefined;
	const result = Oracle.safeParse(raw);
	if (!result.success)
		throw new UsageError(
			`--oracle "${raw}" is not valid; choose one of: ${Oracle.options.join(", ")}`,
		);
	return result.data;
}

export async function importCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { oracle: { type: "string" } },
		allowPositionals: true,
	});
	const file = positionals[0];
	if (!file) throw new UsageError("import needs a JSONL file path");
	const oracle = parseOracleFlag(values.oracle);
	const paths = forgePaths(ctx.forgeDir);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	// The scenario is only written when it is absent, so from the second
	// import onwards `--oracle` had no effect and said nothing -- while the
	// cases already reviewed against the oracle on disk would have been
	// invalidated had it taken effect. Refused by name, before anything is
	// written; repeating the oracle the scenario already has is accepted,
	// since it asks for nothing.
	const scenarios = await readScenarios(ctx.forgeDir);
	const existingScenario = scenarios.find((s) => s.id === IMPORTED_SCENARIO_ID);
	if (
		existingScenario !== undefined &&
		oracle !== undefined &&
		oracle !== existingScenario.oracle
	)
		throw new ForgeError(
			`scenario "${IMPORTED_SCENARIO_ID}" already exists with oracle ${existingScenario.oracle}; --oracle cannot change it — edit .forge/scenarios.yaml`,
			{ file: paths.scenarios, id: IMPORTED_SCENARIO_ID },
		);
	const jsonl = await readFile(file, "utf8").catch(() => {
		throw new ForgeError("file not found", { file });
	});
	const existing = await readCases(ctx.forgeDir, IMPORTED_SCENARIO_ID);
	const result = importCases({
		feature,
		jsonl,
		source: basename(file),
		existing,
		oracle,
	});
	await writeCases(ctx.forgeDir, IMPORTED_SCENARIO_ID, result.cases);
	if (existingScenario === undefined)
		await writeScenarios(ctx.forgeDir, [...scenarios, result.scenario]);
	for (const s of result.skipped)
		ctx.stdout(`import: skipped line ${s.line}: ${s.reason}`);
	ctx.stdout(
		`import: ${result.cases.length - existing.length} new pending cases without expected (${result.skipped.length} skipped)`,
	);
}
