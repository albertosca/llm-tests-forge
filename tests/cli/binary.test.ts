import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_VERSION } from "../../src/core/version";
import { ISOLATED_HOME } from "../helpers/isolated-home";
import { fixturePath, REPOSITORY } from "../helpers/repository";

// A frozen copy of the extract-questions example with its committed outputs,
// so curating the living example under examples/ never changes this test.
const EXAMPLE = fixturePath("extract-questions");
const FAKE_MODEL = `fake/${fixturePath("cli-responses.json")}`;

/** Runs the binary and fails with its own output when the exit code is not 0. */
function expectSuccess(result: { exitCode: number; output: string }) {
	expect({ exitCode: result.exitCode, output: result.output }).toMatchObject({
		exitCode: 0,
	});
}

function runBinary(binary: string, argumentsList: string[], directory: string) {
	const result = Bun.spawnSync([binary, ...argumentsList], {
		cwd: directory,
		env: { ...process.env, NO_COLOR: "1", HOME: ISOLATED_HOME },
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
				join(REPOSITORY, "src/cli/bin.ts"),
				"--outfile",
				binary,
			],
			{ cwd: buildDirectory },
		);
		expect({
			exitCode: build.exitCode,
			output: build.stderr.toString(),
		}).toMatchObject({ exitCode: 0 });

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
		expectSuccess(estimate);
		expect(estimate.output).toContain("total");
		const report = runBinary(binary, ["report", "results.json"], work);
		expectSuccess(report);
		const written = JSON.parse(
			await readFile(join(work, ".forge", "report.json"), "utf8"),
		);
		const committed = JSON.parse(
			await readFile(join(EXAMPLE, ".forge", "report.json"), "utf8"),
		);

		// describe renders the embedded template in an empty directory.
		const fresh = await mkdtemp(join(tmpdir(), "forge-binary-fresh-"));
		const described = runBinary(
			binary,
			["describe", "classify hiring emails", "--drafter", FAKE_MODEL],
			fresh,
		);
		expectSuccess(described);
		expect(
			await readFile(join(fresh, ".forge", "feature.yaml"), "utf8"),
		).toContain("classify-email");

		// emit renders the embedded shim template into the copied fixture,
		// which holds no forge_target.py of its own.
		await expect(
			readFile(join(work, ".forge", "forge_target.py"), "utf8"),
		).rejects.toThrow();
		const emitted = runBinary(binary, ["emit"], work);
		expectSuccess(emitted);
		const shim = await readFile(
			join(work, ".forge", "forge_target.py"),
			"utf8",
		);
		expect(shim.split("\n")[0]).toContain("promptfoo Python provider");

		expect({ ...written, generatedAt: "" }).toEqual({
			...committed,
			generatedAt: "",
		});
	}, 60_000);
});
