import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { messageOf } from "../../src/core/errors";
import {
	describeUsage,
	evalRan,
	minimumPassRateOf,
	problemsIn,
	selectFeatures,
	summariseUsage,
} from "./plan";

const repository = resolve(import.meta.dir, "../..");
const forge = join(repository, "node_modules/.bin/llm-tests-forge");

/** Runs a command with its output on this terminal, so the cost lines show; resolves to its exit code. */
async function run(
	command: string[],
	directory: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<number> {
	const child = Bun.spawn(command, {
		cwd: directory,
		env: environment,
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
	// Through claude -p the targets log each call's usage to a file, because
	// promptfoo's exec provider keeps only stdout and the report shows no cost.
	const usageDirectory = mkdtempSync(join(tmpdir(), "forge-dogfood-usage-"));
	const usageFile = join(usageDirectory, "usage.jsonl");
	const viaClaudeCli = process.env.DOGFOOD_TRANSPORT === "claude-cli";
	for (const step of steps) {
		const isEval = step.includes("eval");
		const exitCode = await run(
			step,
			directory,
			isEval && viaClaudeCli
				? { ...process.env, DOGFOOD_USAGE_FILE: usageFile }
				: process.env,
		);
		if (isEval && viaClaudeCli && existsSync(usageFile))
			console.log(
				`${name}: ${describeUsage(summariseUsage(readFileSync(usageFile, "utf8")))}`,
			);
		if (isEval ? !evalRan(exitCode) : exitCode !== 0) {
			console.log(`${name}: ${step.slice(0, 2).join(" ")} failed`);
			return false;
		}
	}
	rmSync(usageDirectory, { recursive: true, force: true });
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
