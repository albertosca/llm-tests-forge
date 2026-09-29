import { access } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../../core/errors";
import { PROJECT_FILE, registrationHint } from "../../core/project";
import {
	renderStatusLine,
	type SuiteStatus,
	suiteStatus,
} from "../../core/status";
import { FORGE_VERSION } from "../../core/version";
import type { CliContext } from "../context";

/** Where a suite is, as `status` sees it: the project's entries, or the `.forge` here. */
async function suitesToShow(
	context: CliContext,
): Promise<{ entry: string; directory: string }[]> {
	if (context.project !== null) return context.project.suites;
	const present = await access(join(context.cwd, ".forge")).then(
		() => true,
		() => false,
	);
	return present ? [{ entry: ".", directory: context.cwd }] : [];
}

/**
 * One line per registered suite, then one per bad forge.yaml entry; `--json`
 * prints the same as `{ suites, problems }` for an agent. It reads only, so
 * it never stamps a suite, and it never fails on a broken suite: that suite
 * is a line of its own.
 */
export async function statusCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: commandArguments,
		options: { json: { type: "boolean" } },
		allowPositionals: true,
	});
	if (positionals.length > 0)
		throw new UsageError(
			`status takes no argument, got "${positionals.join(" ")}"; it lists every suite of the project`,
		);
	const suites = await suitesToShow(context);
	const problems = context.project?.problems ?? [];
	const statuses: SuiteStatus[] = [];
	for (const suite of suites)
		statuses.push(
			await suiteStatus(suite.entry, suite.directory, FORGE_VERSION),
		);
	if (values.json) {
		context.stdout(JSON.stringify({ suites: statuses, problems }, null, 2));
		return;
	}
	if (context.project === null && suites.length === 0) {
		context.stdout(
			"no llm-tests-forge project here; run llm-tests-forge init to start one",
		);
		return;
	}
	if (
		context.project !== null &&
		suites.length === 0 &&
		problems.length === 0
	) {
		context.stdout(
			`no suites registered in ${context.project.file}; run llm-tests-forge describe in a new directory to start one, or, for a suite that already exists, ${registrationHint("evals/<function>")}`,
		);
		return;
	}
	for (const status of statuses) context.stdout(renderStatusLine(status));
	for (const problem of problems)
		context.stdout(`${PROJECT_FILE}: ${problem.reason}`);
}
