import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainWithTestDefaults as main } from "../helpers/main";
import { fixturePath } from "../helpers/repository";

// A frozen copy of a real recorded run (48 rows, repeat 2, one pair failing
// on both repeats), so curating examples/ never changes what these pin.
const FIXTURE = fixturePath("classify-email");
const MODEL = "anthropic/claude-haiku-4-5";

const STAMP_BLOCK = (rate: number) =>
	`stamp:\n  inputs: [prompt.txt]\n  minimum_pass_rate: ${rate}\n`;

async function project(options: { block?: string } = {}): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-seal-cli-"));
	await cp(FIXTURE, directory, { recursive: true });
	await rm(join(directory, ".forge", "report.json"));
	await rm(join(directory, ".forge", "report.md"));
	const suitePath = join(directory, ".forge", "suite.yaml");
	const suite = await readFile(suitePath, "utf8");
	await writeFile(suitePath, suite + (options.block ?? STAMP_BLOCK(0.9)));
	return directory;
}

/** The recorded results with the failing rows turned into passes: a run that can be sealed. */
async function cleanResults(directory: string): Promise<string> {
	const results = JSON.parse(
		await readFile(join(directory, "results.json"), "utf8"),
	);
	for (const row of results.results.results) row.success = true;
	const path = join(directory, "clean-results.json");
	await writeFile(path, JSON.stringify(results));
	return path;
}

async function run(
	directory: string,
	argv: string[],
): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const code = await main(argv, {
		cwd: directory,
		env: {},
		stdin: async () => "",
		stdout: (line) => lines.push(line),
	});
	return { code, lines };
}

const stampPath = (directory: string) =>
	join(directory, ".forge", "stamp.json");

describe("stamp", () => {
	test("seals a clean run: exit 0, the headline, and a stamp.json that carries the run and the inputs", async () => {
		const directory = await project();
		const { code, lines } = await run(directory, [
			"stamp",
			await cleanResults(directory),
		]);
		expect(lines.join("\n")).toContain("stamp: sealed 1 input at pass rate");
		expect(code).toBe(0);
		const stamp = JSON.parse(await readFile(stampPath(directory), "utf8"));
		expect(stamp).toMatchObject({
			format: 1,
			rows: 48,
			passRate: 1,
			minimumPassRate: 0.9,
			models: { targets: [MODEL], judges: ["anthropic/claude-sonnet-5"] },
			promptfooVersion: "0.123.0",
			flaky: [],
		});
		expect(Object.keys(stamp.inputs)).toEqual(["prompt.txt"]);
		expect(stamp.inputsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("refuses the recorded run, whose one pair failed on both repeats, and writes nothing", async () => {
		const directory = await project();
		const { code, lines } = await run(directory, [
			"stamp",
			join(directory, "results.json"),
		]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain(
			`empty-subject-and-minimal-body-03 @ ${MODEL} is failing`,
		);
		await expect(readFile(stampPath(directory), "utf8")).rejects.toThrow();
	});

	test("refuses a pass rate under the line even with no failing pair", async () => {
		const directory = await project({ block: STAMP_BLOCK(1) });
		const results = JSON.parse(
			await readFile(await cleanResults(directory), "utf8"),
		);
		// One repeat of one pair fails: the pair is flaky, the rate is 47/48.
		results.results.results[0].success = false;
		await writeFile(join(directory, "mixed.json"), JSON.stringify(results));
		const { code, lines } = await run(directory, [
			"stamp",
			join(directory, "mixed.json"),
		]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("is under the line 100.0%");
	});

	test("seals a run with a flaky pair, and lists it", async () => {
		const directory = await project();
		const results = JSON.parse(
			await readFile(await cleanResults(directory), "utf8"),
		);
		results.results.results[0].success = false;
		await writeFile(join(directory, "mixed.json"), JSON.stringify(results));
		const { code, lines } = await run(directory, [
			"stamp",
			join(directory, "mixed.json"),
		]);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("1 flaky pair listed");
		const stamp = JSON.parse(await readFile(stampPath(directory), "utf8"));
		expect(stamp.flaky).toHaveLength(1);
	});

	test("says what to write when suite.yaml has no stamp block", async () => {
		const directory = await project({ block: "" });
		const { code, lines } = await run(directory, [
			"stamp",
			await cleanResults(directory),
		]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("suite.yaml has no stamp block");
	});

	test("refuses an input that does not exist before reading the results", async () => {
		const directory = await project({
			block:
				"stamp:\n  inputs: [prompt.txt, lock.toml]\n  minimum_pass_rate: 0.9\n",
		});
		const { code, lines } = await run(directory, [
			"stamp",
			await cleanResults(directory),
		]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain(
			'stamp.inputs entry "lock.toml" does not exist',
		);
	});

	test("needs a results path", async () => {
		const directory = await project();
		const { code, lines } = await run(directory, ["stamp"]);
		expect(code).toBe(2);
		expect(lines.join("\n")).toContain("stamp needs the path of promptfoo's");
	});

	test("refuses a results file from a model set the suite does not target", async () => {
		const directory = await project();
		const suitePath = join(directory, ".forge", "suite.yaml");
		const suite = await readFile(suitePath, "utf8");
		await writeFile(
			suitePath,
			suite.replace(
				"models: [anthropic/claude-haiku-4-5]",
				"models: [anthropic/claude-haiku-4-5, anthropic/claude-sonnet-5]",
			),
		);
		const { code, lines } = await run(directory, [
			"stamp",
			await cleanResults(directory),
		]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain(
			"the run has no row for anthropic/claude-sonnet-5",
		);
	});
});

async function sealed(options: { block?: string } = {}): Promise<string> {
	const directory = await project(options);
	const { code } = await run(directory, [
		"stamp",
		await cleanResults(directory),
	]);
	expect(code).toBe(0);
	return directory;
}

describe("check", () => {
	test("passes untouched, and says it is offline-ok", async () => {
		const directory = await sealed();
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("check: ok; sealed ");
		expect(lines.join("\n")).toContain("1 input unchanged");
	});

	test("fails naming the prompt when one word of it changes, and passes again once reverted (the simulated change)", async () => {
		const directory = await sealed();
		const promptPath = join(directory, "prompt.txt");
		const original = await readFile(promptPath, "utf8");
		await writeFile(promptPath, original.replace(/\b\w+\b/, "CHANGED"));
		const changed = await run(directory, ["check"]);
		expect(changed.code).toBe(1);
		expect(changed.lines.join("\n")).toContain(
			"prompt.txt changed since the stamp",
		);
		await writeFile(promptPath, original);
		expect((await run(directory, ["check"])).code).toBe(0);
	});

	test("fails when a sealed input is deleted", async () => {
		const directory = await sealed();
		await rm(join(directory, "prompt.txt"));
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("prompt.txt was sealed and is gone");
	});

	test("fails when a new file starts matching a glob input", async () => {
		const directory = await sealed({
			block: "stamp:\n  inputs: ['*.txt']\n  minimum_pass_rate: 0.9\n",
		});
		await writeFile(join(directory, "extra.txt"), "x");
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("extra.txt is new since the stamp");
	});

	test("fails when the judge changed", async () => {
		const directory = await sealed();
		const suitePath = join(directory, ".forge", "suite.yaml");
		const suite = await readFile(suitePath, "utf8");
		await writeFile(
			suitePath,
			suite.replace("judges: [anthropic/claude-sonnet-5]", "judges: [x/y]"),
		);
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("judges changed");
	});

	test("fails when the line is raised above the sealed pass rate", async () => {
		const directory = await project();
		const results = JSON.parse(
			await readFile(await cleanResults(directory), "utf8"),
		);
		results.results.results[0].success = false;
		await writeFile(join(directory, "mixed.json"), JSON.stringify(results));
		await run(directory, ["stamp", join(directory, "mixed.json")]);
		const suitePath = join(directory, ".forge", "suite.yaml");
		const suite = await readFile(suitePath, "utf8");
		await writeFile(
			suitePath,
			suite.replace("minimum_pass_rate: 0.9", "minimum_pass_rate: 0.99"),
		);
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("is under the line 99.0%");
	});

	test("warns, and still passes, when the stamp came from another forge version", async () => {
		const directory = await sealed();
		const path = stampPath(directory);
		const stamp = JSON.parse(await readFile(path, "utf8"));
		stamp.forgeVersion = "0.0.1";
		await writeFile(path, JSON.stringify(stamp));
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain(
			"check: warning: sealed with llm-tests-forge 0.0.1",
		);
	});

	test("warns when the last recorded run was another promptfoo", async () => {
		const directory = await sealed();
		await writeFile(
			join(directory, ".forge", "report.json"),
			JSON.stringify({ promptfooVersion: "9.9.9" }),
		);
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("the last run here is 9.9.9");
	});

	test("an unreadable report.json is no reason to fail", async () => {
		const directory = await sealed();
		await writeFile(join(directory, ".forge", "report.json"), "not json");
		expect((await run(directory, ["check"])).code).toBe(0);
	});

	test("a report.json whose promptfooVersion is not text is ignored", async () => {
		const directory = await sealed();
		await writeFile(
			join(directory, ".forge", "report.json"),
			JSON.stringify({ promptfooVersion: 7 }),
		);
		expect((await run(directory, ["check"])).code).toBe(0);
	});

	test("says to seal when there is no stamp", async () => {
		const directory = await project();
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("no stamp; run the eval");
	});

	test("says what to write when suite.yaml has no stamp block", async () => {
		const directory = await project({ block: "" });
		const { code, lines } = await run(directory, ["check"]);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("suite.yaml has no stamp block");
	});

	test("names a stamp that is not JSON, one of the wrong shape, and one of another format", async () => {
		const directory = await sealed();
		const path = stampPath(directory);
		const good = await readFile(path, "utf8");
		await writeFile(path, "{ not json");
		expect((await run(directory, ["check"])).lines.join("\n")).toContain(
			"invalid JSON",
		);
		await writeFile(path, JSON.stringify({ format: 1 }));
		expect((await run(directory, ["check"])).lines.join("\n")).toContain(
			"is not a stamp written by llm-tests-forge",
		);
		await writeFile(path, JSON.stringify({ ...JSON.parse(good), format: 2 }));
		const other = await run(directory, ["check"]);
		expect(other.code).toBe(1);
		expect(other.lines.join("\n")).toContain(
			"stamp format 2 is not one this llm-tests-forge reads",
		);
	});

	test("does not take arguments", async () => {
		const directory = await sealed();
		const { code } = await run(directory, ["check", "--bogus"]);
		expect(code).toBe(2);
	});
});
