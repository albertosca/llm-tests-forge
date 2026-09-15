import { parseArgs } from "node:util";
import { generateCases } from "../../core/cases";
import { ForgeError } from "../../core/errors";
import {
	readCases,
	readFeature,
	readScenarios,
	writeCases,
} from "../../core/files";
import type { CliContext } from "../context";

function parsePositiveIntFlag(
	flag: string,
	raw: string | undefined,
): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0)
		throw new ForgeError(
			`${flag} "${raw}" is not valid; expected a positive integer`,
		);
	return n;
}

export async function casesCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			n: { type: "string" },
			scenario: { type: "string" },
			model: { type: "string" },
		},
	});
	const n = parsePositiveIntFlag("--n", values.n) ?? 5;
	const feature = await readFeature(ctx.forgeDir);
	const scenarios = await readScenarios(ctx.forgeDir);
	const targets = values.scenario
		? scenarios.filter((s) => s.id === values.scenario)
		: scenarios.filter((s) => s.status === "approved" || s.status === "edited");
	if (targets.length === 0)
		throw new ForgeError(
			values.scenario
				? `scenario "${values.scenario}" not found`
				: "no approved scenario; run `forge review` first",
			{ id: values.scenario },
		);
	for (const scenario of targets) {
		const existing = await readCases(ctx.forgeDir, scenario.id);
		const all = await generateCases({
			feature,
			scenario,
			existing,
			n,
			model: values.model ?? ctx.model,
			llm: ctx.llm,
		});
		await writeCases(ctx.forgeDir, scenario.id, all);
		ctx.stdout(
			`cases: ${scenario.id}: ${all.length - existing.length} new pending (${all.length} total)`,
		);
	}
}
