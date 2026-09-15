import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { describeFeature } from "../../core/describe";
import { ForgeError } from "../../core/errors";
import { forgePaths, writeFeature } from "../../core/files";
import type { CliContext } from "../context";

export async function describeCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			"prompt-file": { type: "string" },
			model: { type: "string" },
		},
		allowPositionals: true,
	});
	const text =
		positionals.length > 0 ? positionals.join(" ") : await ctx.stdin();
	const promptFile = values["prompt-file"];
	const promptText = promptFile
		? await readFile(promptFile, "utf8").catch(() => {
				throw new ForgeError("file not found", { file: promptFile });
			})
		: undefined;
	const feature = await describeFeature({
		text,
		promptText,
		model: values.model ?? ctx.model,
		llm: ctx.llm,
	});
	const withFile = promptFile
		? { ...feature, prompt_file: promptFile }
		: feature;
	await writeFeature(ctx.forgeDir, withFile);
	ctx.stdout(
		`describe: feature "${withFile.id}" written as pending -> ${forgePaths(ctx.forgeDir).feature}; run \`forge review\` to approve it`,
	);
}
