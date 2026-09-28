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
import type { Case } from "../../core/schemas";
import type { CliContext } from "../context";

export async function dedupeCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
		options: {
			scenario: { type: "string" },
			drafter: { type: "string" },
		},
	});
	if (values.scenario) {
		const scenarios = await readScenarios(context.forgeDir);
		if (!scenarios.some((scenario) => scenario.id === values.scenario))
			throw new ForgeError(`scenario "${values.scenario}" not found`, {
				id: values.scenario,
			});
	}
	const ids = values.scenario
		? [values.scenario]
		: await listCaseScenarios(context.forgeDir);
	if (ids.length === 0)
		throw new ForgeError(
			"no cases to dedupe; run `llm-tests-forge cases` first",
			{
				file: forgePaths(context.forgeDir).casesDir,
			},
		);
	// Every file is read and checked before the first one is written. This
	// check used to live in the loop below, where a bad scenario in the
	// middle of the list exited non-zero with the scenarios before it
	// already rewritten — half-applied, which is not what the rest of the
	// pipeline promises.
	const casesById = new Map<string, Case[]>();
	for (const id of ids) {
		const cases = await readCases(context.forgeDir, id);
		// A known scenario with no cases yet is the second entrance to the
		// phantom file: dedupeCases returns early below two cases, and the
		// unconditional write below then created
		// `.forge/cases/<id>.yaml` holding `[]`, which listCaseScenarios
		// happily reports to every later run as a scenario with cases.
		if (cases.length === 0)
			throw new ForgeError(
				`scenario "${id}" has no cases yet; run \`llm-tests-forge cases --scenario ${id}\` first`,
				{ id },
			);
		casesById.set(id, cases);
	}
	for (const [id, cases] of casesById) {
		const marked = await dedupeCases({
			cases,
			model: values.drafter ?? context.drafter,
			llm: context.llm,
		});
		await writeCases(context.forgeDir, id, marked);
		const count = marked.filter(
			(kase) => kase.duplicate_of !== undefined,
		).length;
		context.stdout(`dedupe: ${id}: ${count} marked as duplicates`);
	}
}
