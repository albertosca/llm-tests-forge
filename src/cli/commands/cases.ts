import { parseArgs } from "node:util";
import { generateCases } from "../../core/cases";
import { ForgeError } from "../../core/errors";
import {
	forgePaths,
	readCases,
	readFeature,
	readScenarios,
	writeCases,
} from "../../core/files";
import type { CliContext } from "../context";
import { parsePositiveIntFlag } from "../flags";
import { requireApprovedFeature } from "../gates";

export async function casesCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
		options: {
			n: { type: "string" },
			scenario: { type: "string" },
			drafter: { type: "string" },
		},
	});
	const count = parsePositiveIntFlag("--n", values.n) ?? 5;
	const feature = await readFeature(context.forgeDir);
	requireApprovedFeature(feature, forgePaths(context.forgeDir).feature);
	const scenarios = await readScenarios(context.forgeDir);
	const targets = values.scenario
		? scenarios.filter((scenario) => scenario.id === values.scenario)
		: scenarios.filter(
				(scenario) =>
					scenario.status === "approved" || scenario.status === "edited",
			);
	if (targets.length === 0)
		throw new ForgeError(
			values.scenario
				? `scenario "${values.scenario}" not found`
				: "no approved scenario; run `llm-tests-forge review` first",
			{ id: values.scenario },
		);
	for (const scenario of targets) {
		const existing = await readCases(context.forgeDir, scenario.id);
		const all = await generateCases({
			feature,
			scenario,
			existing,
			n: count,
			model: values.drafter ?? context.drafter,
			llm: context.llm,
		});
		await writeCases(context.forgeDir, scenario.id, all);
		context.stdout(
			`cases: ${scenario.id}: ${all.length - existing.length} new pending (${all.length} total)`,
		);
	}
}
