import { parseArgs } from "node:util";
import { UsageError } from "../../core/errors";
import {
	forgePaths,
	readFeature,
	readScenarios,
	writeScenarios,
} from "../../core/files";
import { enumerateScenarios } from "../../core/scenarios";
import { Kind } from "../../core/schemas";
import type { CliContext } from "../context";
import { parsePositiveIntFlag } from "../flags";
import { requireApprovedFeature } from "../gates";

function parseKindsFlag(raw: string | undefined): Kind[] | undefined {
	if (raw === undefined) return undefined;
	return raw.split(",").map((part) => {
		const value = part.trim();
		const result = Kind.safeParse(value);
		if (!result.success)
			throw new UsageError(
				`--kinds "${value}" is not valid; choose from: ${Kind.options.join(", ")}`,
			);
		return result.data;
	});
}

export async function scenariosCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
		options: {
			kinds: { type: "string" },
			more: { type: "string" },
			drafter: { type: "string" },
		},
	});
	const feature = await readFeature(context.forgeDir);
	requireApprovedFeature(feature, forgePaths(context.forgeDir).feature);
	const kinds = parseKindsFlag(values.kinds);
	const more = parsePositiveIntFlag("--more", values.more);
	const existing = await readScenarios(context.forgeDir);
	const all = await enumerateScenarios({
		feature,
		existing,
		kinds,
		more,
		model: values.drafter ?? context.drafter,
		llm: context.llm,
	});
	await writeScenarios(context.forgeDir, all);
	context.stdout(
		`scenarios: ${all.length - existing.length} new pending (${all.length} total) -> ${forgePaths(context.forgeDir).scenarios}`,
	);
}
