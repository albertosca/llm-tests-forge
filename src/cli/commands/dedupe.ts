import { parseArgs } from "node:util";
import { dedupeCases } from "../../core/dedupe";
import { ForgeError } from "../../core/errors";
import {
	forgePaths,
	listCaseScenarios,
	readCases,
	readScenarios,
	writeCases,
} from "../../core/files";
import type { CliContext } from "../context";

export async function dedupeCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			scenario: { type: "string" },
			model: { type: "string" },
		},
	});
	if (values.scenario) {
		const scenarios = await readScenarios(ctx.forgeDir);
		if (!scenarios.some((s) => s.id === values.scenario))
			throw new ForgeError(`scenario "${values.scenario}" not found`, {
				id: values.scenario,
			});
	}
	const ids = values.scenario
		? [values.scenario]
		: await listCaseScenarios(ctx.forgeDir);
	if (ids.length === 0)
		throw new ForgeError("no cases to dedupe; run `forge cases` first", {
			file: forgePaths(ctx.forgeDir).casesDir,
		});
	for (const id of ids) {
		const cases = await readCases(ctx.forgeDir, id);
		// A known scenario with no cases yet is the second entrance to the
		// phantom file: dedupeCases returns early below two cases, and the
		// unconditional write below then created
		// `.forge/cases/<id>.yaml` holding `[]`, which listCaseScenarios
		// happily reports to every later run as a scenario with cases.
		if (cases.length === 0)
			throw new ForgeError(
				`scenario "${id}" has no cases yet; run \`forge cases --scenario ${id}\` first`,
				{ id },
			);
		const marked = await dedupeCases({
			cases,
			model: values.model ?? ctx.model,
			llm: ctx.llm,
		});
		await writeCases(ctx.forgeDir, id, marked);
		const count = marked.filter((c) => c.duplicate_of !== undefined).length;
		ctx.stdout(`dedupe: ${id}: ${count} marked as duplicates`);
	}
}
