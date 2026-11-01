import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { messageOf } from "../../src/core/errors";
import { evalRan, minimumPassRateOf, problemsIn, selectFeatures } from "./plan";

const repository = resolve(import.meta.dir, "../..");
const forge = join(repository, "node_modules/.bin/llm-tests-forge");

/** Runs a command with its output on this terminal, so the cost lines show; resolves to its exit code. */
async function run(command: string[], directory: string): Promise<number> {
	const child = Bun.spawn(command, {
		cwd: directory,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await child.exited;
}

async function dogfoodFeature(
	name: string,
	minimumPassRate: number,
): Promise<boolean> {
	const directory = join(repository, "dogfood", name);
	const baseline = join(directory, "baseline-report.json");
	if (!existsSync(baseline)) {
		console.log(
			`${name}: no baseline-report.json; commit .forge/report.json as baseline-report.json to start one`,
		);
		return false;
	}
	// The sealed results.json stays as committed; the new run goes beside it,
	// and a copy left by an earlier run is removed so it can never be read as new.
	rmSync(join(directory, "results.latest.json"), { force: true });
	const steps = [
		[forge, "estimate"],
		[
			"bunx",
			"promptfoo@0.123.0",
			"eval",
			"-c",
			".forge/promptfooconfig.yaml",
			"-o",
			"results.latest.json",
			"--no-cache",
			"--no-progress-bar",
			"-j",
			"2",
		],
		[
			forge,
			"report",
			"results.latest.json",
			"--baseline",
			"baseline-report.json",
		],
	];
	for (const step of steps) {
		const exitCode = await run(step, directory);
		const isEval = step.includes("eval");
		if (isEval ? !evalRan(exitCode) : exitCode !== 0) {
			console.log(`${name}: ${step.slice(0, 2).join(" ")} failed`);
			return false;
		}
	}
	const problems = problemsIn(
		readFileSync(join(directory, ".forge/report.json"), "utf8"),
		minimumPassRate,
	);
	console.log(
		`${name}: ${problems.length === 0 ? "clean" : problems.join("; ")}`,
	);
	return problems.length === 0;
}

try {
	const available = readdirSync(join(repository, "dogfood"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	const features = selectFeatures(available, process.argv.slice(2));
	// Every suite is validated before the first paid step, so a broken
	// suite.yaml cannot cut the run short after money was spent.
	const minimums = features.map((name) =>
		minimumPassRateOf(
			readFileSync(
				join(repository, "dogfood", name, ".forge/suite.yaml"),
				"utf8",
			),
		),
	);
	let allClean = true;
	for (const [index, name] of features.entries())
		allClean =
			(await dogfoodFeature(name, minimums[index] as number)) && allClean;
	process.exitCode = allClean ? 0 : 1;
} catch (error) {
	console.error(messageOf(error));
	process.exitCode = 1;
}
