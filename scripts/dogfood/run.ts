import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { messageOf } from "../../src/core/errors";
import { regressionsIn, selectFeatures } from "./plan";

const repository = resolve(import.meta.dir, "../..");
const forge = join(repository, "node_modules/.bin/llm-tests-forge");

/** Runs a command with its output on this terminal, so the cost lines show; true when it exited 0. */
async function run(command: string[], directory: string): Promise<boolean> {
	const child = Bun.spawn(command, {
		cwd: directory,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return (await child.exited) === 0;
}

async function dogfoodFeature(name: string): Promise<boolean> {
	const directory = join(repository, "dogfood", name);
	const baseline = join(directory, "baseline-report.json");
	const reportCommand = [forge, "report", "results.json"];
	if (existsSync(baseline))
		reportCommand.push("--baseline", "baseline-report.json");
	else
		console.log(
			`${name}: no baseline yet: commit .forge/report.json as baseline-report.json to start one`,
		);
	const steps = [
		[forge, "estimate"],
		[
			"bunx",
			"promptfoo@0.123.0",
			"eval",
			"-c",
			".forge/promptfooconfig.yaml",
			"-o",
			"results.json",
			"--no-cache",
			"--no-progress-bar",
			"-j",
			"2",
		],
		reportCommand,
	];
	for (const step of steps)
		if (!(await run(step, directory))) {
			console.log(`${name}: ${step.slice(0, 2).join(" ")} failed`);
			return false;
		}
	const regressions = regressionsIn(
		readFileSync(join(directory, ".forge/report.json"), "utf8"),
	);
	console.log(`${name}: ${regressions} regressions`);
	return regressions === 0;
}

try {
	const available = readdirSync(join(repository, "dogfood"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	const features = selectFeatures(available, process.argv.slice(2));
	let allClean = true;
	for (const name of features)
		allClean = (await dogfoodFeature(name)) && allClean;
	process.exitCode = allClean ? 0 : 1;
} catch (error) {
	console.error(messageOf(error));
	process.exitCode = 1;
}
