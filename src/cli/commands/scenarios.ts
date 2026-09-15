import { parseArgs } from "node:util";
import { ForgeError } from "../../core/errors";
import {
	forgePaths,
	readFeature,
	readScenarios,
	writeScenarios,
} from "../../core/files";
import { enumerateScenarios } from "../../core/scenarios";
import { Kind } from "../../core/schemas";
import type { CliContext } from "../context";

function parseKindsFlag(raw: string | undefined): Kind[] | undefined {
	if (raw === undefined) return undefined;
	return raw.split(",").map((part) => {
		const value = part.trim();
		const result = Kind.safeParse(value);
		if (!result.success)
			throw new ForgeError(
				`--kinds "${value}" is not valid; choose from: ${Kind.options.join(", ")}`,
			);
		return result.data;
	});
}

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

export async function scenariosCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			kinds: { type: "string" },
			more: { type: "string" },
			model: { type: "string" },
		},
	});
	const feature = await readFeature(ctx.forgeDir);
	if (feature.status === "pending")
		throw new ForgeError("feature is pending; run `forge review` first", {
			file: forgePaths(ctx.forgeDir).feature,
		});
	const kinds = parseKindsFlag(values.kinds);
	const more = parsePositiveIntFlag("--more", values.more);
	const existing = await readScenarios(ctx.forgeDir);
	const all = await enumerateScenarios({
		feature,
		existing,
		kinds,
		more,
		model: values.model ?? ctx.model,
		llm: ctx.llm,
	});
	await writeScenarios(ctx.forgeDir, all);
	ctx.stdout(
		`scenarios: ${all.length - existing.length} new pending (${all.length} total) -> ${forgePaths(ctx.forgeDir).scenarios}`,
	);
}
