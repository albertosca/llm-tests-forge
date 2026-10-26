import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, messageOf } from "../../core/errors";
import { forgePaths, readSuite } from "../../core/files";
import {
	checkStamp,
	requireStampBlock,
	resolveInputs,
	STAMP_FORMAT,
	type StampFile,
	StampFileSchema,
} from "../../core/seal";
import { plural } from "../../core/text";
import { FORGE_VERSION } from "../../core/version";
import type { CliContext } from "../context";

async function readStamp(path: string): Promise<StampFile> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new ForgeError(
			"no stamp; run the eval, `llm-tests-forge report`, then `llm-tests-forge stamp`",
			{ file: path },
		);
	});
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new ForgeError(`invalid JSON: ${messageOf(error)}`, { file: path });
	}
	const parsed = StampFileSchema.safeParse(data);
	if (!parsed.success)
		throw new ForgeError(
			`is not a stamp written by llm-tests-forge: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
			{ file: path },
		);
	if (parsed.data.format !== STAMP_FORMAT)
		throw new ForgeError(
			`stamp format ${parsed.data.format} is not one this llm-tests-forge reads (it reads ${STAMP_FORMAT}); seal again with \`llm-tests-forge stamp\``,
			{ file: path },
		);
	return parsed.data;
}

/** The promptfoo version of the last run recorded here, for the version note; null when there is none to read. */
async function lastRunVersion(path: string): Promise<string | null> {
	try {
		const data: unknown = JSON.parse(await readFile(path, "utf8"));
		const version = (data as { promptfooVersion?: unknown }).promptfooVersion;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

export async function checkCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	parseArgs({ args: commandArguments, options: {} });
	const paths = forgePaths(context.forgeDirectory);
	const suite = await readSuite(
		context.forgeDirectory,
		context.project?.config.language,
	);
	const block = requireStampBlock(suite);
	const stamp = await readStamp(paths.stamp);
	const current = await resolveInputs(
		resolve(context.forgeDirectory, ".."),
		block.inputs,
		{ lenient: true },
	);
	const { failures, warnings } = checkStamp({
		stamp,
		current,
		suite,
		versions: {
			forge: FORGE_VERSION,
			promptfoo: await lastRunVersion(paths.reportJson),
		},
	});
	for (const warning of warnings) context.stdout(`check: warning: ${warning}`);
	if (failures.length > 0)
		throw new ForgeError(
			`the stamp no longer describes this repository:\n${failures.map((reason) => `  - ${reason}`).join("\n")}\nrun the eval again, \`llm-tests-forge report\`, review the result, then \`llm-tests-forge stamp\``,
			{ file: paths.stamp },
		);
	context.stdout(
		`check: ok; sealed ${stamp.sealedAt} at pass rate ${(stamp.passRate * 100).toFixed(1)}%, ${plural(Object.keys(current).length, "input")} unchanged`,
	);
}
