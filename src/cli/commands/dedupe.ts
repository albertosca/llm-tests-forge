import { parseArgs } from "node:util";
import { dedupeCases } from "../../core/dedupe";
import { listCaseScenarios, readCases, writeCases } from "../../core/files";
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
	const ids = values.scenario
		? [values.scenario]
		: await listCaseScenarios(ctx.forgeDir);
	for (const id of ids) {
		const cases = await readCases(ctx.forgeDir, id);
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
