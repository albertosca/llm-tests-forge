import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import { forgePaths, readSuite, writeText } from "../../core/files";
import {
	buildStamp,
	requireStampBlock,
	resolveInputs,
	sealRefusals,
} from "../../core/seal";
import { plural } from "../../core/text";
import { FORGE_VERSION } from "../../core/version";
import type { CliContext } from "../context";
import { buildReportFor } from "./report";

export async function stampCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { positionals } = parseArgs({
		args: commandArguments,
		options: {},
		allowPositionals: true,
	});
	const resultsPath = positionals[0];
	if (!resultsPath)
		throw new UsageError("stamp needs the path of promptfoo's results.json");
	const paths = forgePaths(context.forgeDirectory);
	const suite = await readSuite(
		context.forgeDirectory,
		context.project?.config.language,
	);
	const block = requireStampBlock(suite);
	const hashes = await resolveInputs(
		resolve(context.forgeDirectory, ".."),
		block.inputs,
	);
	const report = await buildReportFor(context, resultsPath);
	const refusals = sealRefusals(report, suite);
	if (refusals.length > 0)
		throw new ForgeError(
			`not sealed, nothing written:\n${refusals.map((reason) => `  - ${reason}`).join("\n")}\nfix these, run the eval again, \`llm-tests-forge report\`, then \`llm-tests-forge stamp\``,
		);
	const stamp = buildStamp({
		report,
		suite,
		hashes,
		forgeVersion: FORGE_VERSION,
		now: new Date(),
	});
	await writeText(paths.stamp, `${JSON.stringify(stamp, null, 2)}\n`);
	context.stdout(
		`stamp: sealed ${plural(Object.keys(hashes).length, "input")} at pass rate ${(stamp.passRate * 100).toFixed(1)}% (line ${(stamp.minimumPassRate * 100).toFixed(1)}%)${stamp.flaky.length > 0 ? `; ${plural(stamp.flaky.length, "flaky pair")} listed` : ""}`,
	);
	context.stdout(`stamp: wrote ${paths.stamp}; commit it`);
}
