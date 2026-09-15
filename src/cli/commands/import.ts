import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError } from "../../core/errors";
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
		throw new ForgeError(
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
	if (!file) throw new ForgeError("import needs a JSONL file path");
	const oracle = parseOracleFlag(values.oracle);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, forgePaths(ctx.forgeDir).feature);
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
	const scenarios = await readScenarios(ctx.forgeDir);
	if (!scenarios.some((s) => s.id === IMPORTED_SCENARIO_ID))
		await writeScenarios(ctx.forgeDir, [...scenarios, result.scenario]);
	for (const s of result.skipped)
		ctx.stdout(`import: skipped line ${s.line}: ${s.reason}`);
	ctx.stdout(
		`import: ${result.cases.length - existing.length} new pending cases without expected (${result.skipped.length} skipped)`,
	);
}
