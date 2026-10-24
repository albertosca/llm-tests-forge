import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMain } from "../release/entry";
import { compareReports } from "./compare";

/**
 * The self-consistency check of the committed examples: each example's
 * report is regenerated from its committed results.json by the forge's own
 * `report` verb and compared with the committed one (see compare.ts for
 * what is excluded and why). It reads `examples/` on purpose, as a check of
 * the examples and not of the code, which is why it is a script run by its
 * own CI job and not a test: curating an example must never turn
 * `bun run check` red. It never writes to `examples/`: the work happens in a
 * copy under the system temporary directory, removed afterwards.
 *
 * Needs no API key and no network: `report` only reads files. This file is
 * not imported by any test, so the coverage gate does not see it; its logic
 * lives in compare.ts, which is tested.
 */

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const FORGE_ENTRY = join(REPOSITORY_ROOT, "src/cli/bin.ts");
const EXAMPLES_DIRECTORY = join(REPOSITORY_ROOT, "examples");

/** The examples that carry a committed report and the results it came from. */
export async function listExamples(
	examplesDirectory: string = EXAMPLES_DIRECTORY,
): Promise<string[]> {
	const names = (await readdir(examplesDirectory)).sort();
	const examples: string[] = [];
	for (const name of names) {
		const hasReport = await Bun.file(
			join(examplesDirectory, name, ".forge/report.json"),
		).exists();
		const hasResults = await Bun.file(
			join(examplesDirectory, name, "results.json"),
		).exists();
		if (hasReport && hasResults) examples.push(name);
	}
	return examples;
}

/**
 * The differences between one example's committed report and the one the
 * forge regenerates from its committed results; empty when they match.
 * `tamper` runs on the temporary copy before the regeneration (a canary: the
 * check must notice a changed input).
 */
export async function checkExample(
	exampleDirectory: string,
	tamper?: (temporaryDirectory: string) => Promise<void>,
): Promise<string[]> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "forge-example-"));
	try {
		await cp(exampleDirectory, temporaryDirectory, { recursive: true });
		await tamper?.(temporaryDirectory);
		const reportProcess = Bun.spawn(
			["bun", FORGE_ENTRY, "report", "results.json"],
			{ cwd: temporaryDirectory, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, errorText] = await Promise.all([
			reportProcess.exited,
			new Response(reportProcess.stderr).text(),
		]);
		if (exitCode !== 0)
			return [`report exited ${exitCode}: ${errorText.trim()}`];
		const read = (directory: string, file: string): Promise<string> =>
			readFile(join(directory, ".forge", file), "utf8");
		return compareReports(
			{
				json: await read(exampleDirectory, "report.json"),
				markdown: await read(exampleDirectory, "report.md"),
			},
			{
				json: await read(temporaryDirectory, "report.json"),
				markdown: await read(temporaryDirectory, "report.md"),
			},
		);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function runCheckExamples(
	_argumentsList: string[],
	print: (line: string) => void,
): Promise<number> {
	const examples = await listExamples();
	let failed = 0;
	for (const name of examples) {
		const differences = await checkExample(join(EXAMPLES_DIRECTORY, name));
		if (differences.length === 0) print(`ok   ${name}`);
		for (const difference of differences) {
			failed += 1;
			print(`FAIL ${name}: ${difference}`);
		}
	}
	if (examples.length === 0) {
		print("no example with a report and results found");
		return 1;
	}
	return failed === 0 ? 0 : 1;
}

await runMain(import.meta.main, runCheckExamples);
