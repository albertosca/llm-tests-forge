import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FORGE_VERSION } from "../../src/core/version";

const EXAMPLE = resolve("examples/moonlighter-extract-questions");

function runBinary(binary: string, argumentsList: string[], directory: string) {
	const result = Bun.spawnSync([binary, ...argumentsList], {
		cwd: directory,
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		exitCode: result.exitCode,
		output: `${result.stdout.toString()}${result.stderr.toString()}`,
	};
}

describe("the compiled binary", () => {
	test("runs --version, estimate and report with templates and prices embedded, reproducing the committed report", async () => {
		const buildDirectory = await mkdtemp(join(tmpdir(), "forge-binary-"));
		const binary = join(buildDirectory, "llm-tests-forge");
		// The build writes a temporary file into its working directory.
		const build = Bun.spawnSync(
			[
				"bun",
				"build",
				"--compile",
				resolve("src/cli/bin.ts"),
				"--outfile",
				binary,
			],
			{ cwd: buildDirectory },
		);
		expect(build.exitCode).toBe(0);

		const work = await mkdtemp(join(tmpdir(), "forge-binary-work-"));
		await cp(join(EXAMPLE, ".forge"), join(work, ".forge"), {
			recursive: true,
		});
		await cp(join(EXAMPLE, "prompt.txt"), join(work, "prompt.txt"));
		await cp(join(EXAMPLE, "results.json"), join(work, "results.json"));

		expect(runBinary(binary, ["--version"], work)).toEqual({
			exitCode: 0,
			output: `${FORGE_VERSION}\n`,
		});
		const estimate = runBinary(binary, ["estimate"], work);
		expect(estimate.exitCode).toBe(0);
		expect(estimate.output).toContain("total");
		const report = runBinary(binary, ["report", "results.json"], work);
		expect(report.exitCode).toBe(0);
		const written = JSON.parse(
			await readFile(join(work, ".forge", "report.json"), "utf8"),
		);
		const committed = JSON.parse(
			await readFile(join(EXAMPLE, ".forge", "report.json"), "utf8"),
		);
		expect({ ...written, generatedAt: "" }).toEqual({
			...committed,
			generatedAt: "",
		});
	}, 60_000);
});
