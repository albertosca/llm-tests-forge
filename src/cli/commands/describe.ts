import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { describeFeature } from "../../core/describe";
import { ForgeError } from "../../core/errors";
import {
	forgePaths,
	readFeatureIfPresent,
	writeFeature,
} from "../../core/files";
import type { CliContext } from "../context";

/**
 * `describe` is the one verb that replaces a whole file rather than
 * appending to it, and `feature.yaml`'s `invariants` are the rules the
 * person adds by hand — the highest-value human input in the pipeline.
 * Overwriting a feature that has been through review is therefore refused
 * by name, before a single token is spent, unless `--force` says that is
 * exactly what was wanted. A still-pending feature is nobody's reviewed
 * work, so re-describing over it stays free.
 */
async function refuseToOverwriteReviewedFeature(
	context: CliContext,
	force: boolean,
): Promise<void> {
	if (force) return;
	const existing = await readFeatureIfPresent(context.forgeDirectory);
	if (existing === undefined || existing.status === "pending") return;
	throw new ForgeError(
		`feature "${existing.id}" is already ${existing.status}; describe would overwrite the reviewed description and its invariants — re-run with --force to replace it`,
		{ file: forgePaths(context.forgeDirectory).feature, id: existing.id },
	);
}

export async function describeCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: commandArguments,
		options: {
			"prompt-file": { type: "string" },
			drafter: { type: "string" },
			force: { type: "boolean" },
		},
		allowPositionals: true,
	});
	await refuseToOverwriteReviewedFeature(context, values.force === true);
	const text =
		positionals.length > 0 ? positionals.join(" ") : await context.stdin();
	const promptFile = values["prompt-file"];
	const promptText = promptFile
		? await readFile(promptFile, "utf8").catch(() => {
				throw new ForgeError("file not found", { file: promptFile });
			})
		: undefined;
	const feature = await describeFeature({
		text,
		promptText,
		model: values.drafter ?? context.drafter,
		llm: context.llm,
	});
	const withFile = promptFile
		? { ...feature, prompt_file: promptFile }
		: feature;
	await writeFeature(context.forgeDirectory, withFile);
	context.stdout(
		`describe: feature "${withFile.id}" written as pending -> ${forgePaths(context.forgeDirectory).feature}; run \`llm-tests-forge review\` to approve it`,
	);
}
