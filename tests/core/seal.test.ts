import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../../src/core/report";
import type { Suite } from "../../src/core/schemas";
import {
	buildStamp,
	checkStamp,
	inputsHashOf,
	requireStampBlock,
	resolveInputs,
	type StampFile,
	sealRefusals,
} from "../../src/core/seal";

async function tree(files: Record<string, string>): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "forge-seal-"));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(base, path, ".."), { recursive: true });
		await writeFile(join(base, path), text);
	}
	return join(base, "project");
}

describe("resolveInputs", () => {
	test("hashes a literal path and keys it as written, sorted", async () => {
		const base = await tree({
			"project/b.txt": "b",
			"project/a.txt": "a",
		});
		const hashes = await resolveInputs(base, ["b.txt", "a.txt"]);
		expect(Object.keys(hashes)).toEqual(["a.txt", "b.txt"]);
		expect(hashes["a.txt"]).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(hashes["a.txt"]).not.toBe(hashes["b.txt"]);
	});

	test("expands a glob to every file it matches, and counts a file named twice once", async () => {
		const base = await tree({
			"project/prompts/one.txt": "1",
			"project/prompts/two.txt": "2",
			"project/prompts/skip.md": "3",
		});
		const hashes = await resolveInputs(base, [
			"prompts/*.txt",
			"prompts/one.txt",
		]);
		expect(Object.keys(hashes)).toEqual(["prompts/one.txt", "prompts/two.txt"]);
	});

	test("reaches a lockfile above the project through ..", async () => {
		const base = await tree({ "uv.lock": "lock", "project/p.txt": "p" });
		const hashes = await resolveInputs(base, ["../uv.lock"]);
		expect(Object.keys(hashes)).toEqual(["../uv.lock"]);
	});

	test("refuses an absolute path, naming the entry", async () => {
		const base = await tree({ "project/p.txt": "p" });
		await expect(resolveInputs(base, ["/etc/hosts"])).rejects.toThrow(
			'stamp.inputs entry "/etc/hosts" is an absolute path',
		);
	});

	test("refuses a literal path that does not exist, naming the entry", async () => {
		const base = await tree({ "project/p.txt": "p" });
		await expect(resolveInputs(base, ["missing.txt"])).rejects.toThrow(
			'stamp.inputs entry "missing.txt" does not exist',
		);
	});

	test("refuses a glob that matches nothing, naming the entry", async () => {
		const base = await tree({ "project/p.txt": "p" });
		await expect(resolveInputs(base, ["nothing/*.txt"])).rejects.toThrow(
			'stamp.inputs entry "nothing/*.txt" matches no file',
		);
	});

	test("lenient leaves out what is gone instead of refusing: a missing literal, an empty glob, a directory", async () => {
		const base = await tree({ "project/p.txt": "p", "project/dir/q.txt": "q" });
		const hashes = await resolveInputs(
			base,
			["p.txt", "missing.txt", "nothing/*.txt", "dir"],
			{ lenient: true },
		);
		expect(Object.keys(hashes)).toEqual(["p.txt"]);
	});

	test("lenient still refuses an absolute path", async () => {
		const base = await tree({ "project/p.txt": "p" });
		await expect(
			resolveInputs(base, ["/etc/hosts"], { lenient: true }),
		).rejects.toThrow("is an absolute path");
	});

	test("refuses a directory named as a literal entry", async () => {
		const base = await tree({ "project/dir/p.txt": "p" });
		await expect(resolveInputs(base, ["dir"])).rejects.toThrow(
			'stamp.inputs entry "dir" is not a file',
		);
	});
});

describe("inputsHashOf", () => {
	test("is the same for the same hashes whatever the key order, and changes with one hash", () => {
		const first = inputsHashOf({ "a.txt": "sha256:1", "b.txt": "sha256:2" });
		expect(inputsHashOf({ "b.txt": "sha256:2", "a.txt": "sha256:1" })).toBe(
			first,
		);
		expect(inputsHashOf({ "a.txt": "sha256:1", "b.txt": "sha256:3" })).not.toBe(
			first,
		);
	});

	test("does not confuse one file renamed with the same content for another", () => {
		expect(inputsHashOf({ "a.txt": "sha256:1" })).not.toBe(
			inputsHashOf({ "b.txt": "sha256:1" }),
		);
	});
});

function runOf(
	stabilities: Array<[string, string, Report["cases"][number]["stability"]]>,
	passRate: number,
): Report {
	return {
		passRate,
		cases: stabilities.map(([name, model, stability]) => ({
			case: name,
			scenario: "s",
			model,
			runs: 2,
			passed: 0,
			failed: 0,
			errored: 0,
			stability,
			reasons: [],
		})),
	} as unknown as Report;
}

const SUITE = {
	target: { kind: "python", models: ["anthropic/claude-haiku-4-5"] },
	judges: ["anthropic/claude-sonnet-5"],
	repeat: 2,
	include: [],
	stamp: { inputs: ["prompt.txt"], minimum_pass_rate: 0.9 },
} as unknown as Suite;

describe("sealRefusals", () => {
	const model = "anthropic/claude-haiku-4-5";

	test("says nothing about a clean run, flaky pairs included", () => {
		expect(
			sealRefusals(
				runOf(
					[
						["a", model, "stable"],
						["b", model, "flaky"],
					],
					0.95,
				),
				SUITE,
			),
		).toEqual([]);
	});

	test.each(["failing", "errored", "partly-errored"] as const)(
		"refuses a pair that is %s, naming case and model",
		(stability) => {
			const refusals = sealRefusals(
				runOf(
					[
						["a", model, "stable"],
						["b", model, stability],
					],
					0.95,
				),
				SUITE,
			);
			expect(refusals).toEqual([`b @ ${model} is ${stability}`]);
		},
	);

	test("refuses a pass rate under the line, in percent", () => {
		expect(sealRefusals(runOf([["a", model, "stable"]], 0.875), SUITE)).toEqual(
			["pass rate 87.5% is under the line 90.0%"],
		);
	});

	test("accepts a pass rate exactly on the line", () => {
		expect(sealRefusals(runOf([["a", model, "stable"]], 0.9), SUITE)).toEqual(
			[],
		);
	});

	test("refuses a run that has no row for a target model of the suite", () => {
		const refusals = sealRefusals(
			runOf([["a", "anthropic/claude-sonnet-5", "stable"]], 0.95),
			SUITE,
		);
		expect(refusals).toEqual([`the run has no row for ${model}`]);
	});

	test("reports every refusal, not the first", () => {
		const refusals = sealRefusals(runOf([["a", model, "failing"]], 0.5), SUITE);
		expect(refusals).toHaveLength(2);
	});
});

const STAMP: StampFile = {
	format: 1,
	sealedAt: "2026-10-25T21:00:00.000Z",
	forgeVersion: "1.2.3",
	promptfooVersion: "0.123.0",
	ranAt: "2026-10-25T20:40:00.000Z",
	models: {
		targets: ["anthropic/claude-haiku-4-5"],
		judges: ["anthropic/claude-sonnet-5"],
	},
	inputs: { "prompt.txt": "sha256:aaa" },
	inputsHash: inputsHashOf({ "prompt.txt": "sha256:aaa" }),
	rows: 48,
	passRate: 0.94,
	minimumPassRate: 0.9,
	flaky: [],
};

function check(
	overrides: {
		inputs?: Record<string, string>;
		suite?: Suite;
		versions?: { forge: string; promptfoo: string | null };
		stamp?: StampFile;
	} = {},
) {
	return checkStamp({
		stamp: overrides.stamp ?? STAMP,
		current: overrides.inputs ?? { "prompt.txt": "sha256:aaa" },
		suite: overrides.suite ?? SUITE,
		versions: overrides.versions ?? { forge: "1.2.3", promptfoo: "0.123.0" },
	});
}

describe("checkStamp", () => {
	test("passes, with nothing to say, when nothing moved", () => {
		expect(check()).toEqual({ failures: [], warnings: [] });
	});

	test("names a changed input", () => {
		expect(check({ inputs: { "prompt.txt": "sha256:bbb" } }).failures).toEqual([
			"prompt.txt changed since the stamp",
		]);
	});

	test("names an input that vanished", () => {
		expect(check({ inputs: {} }).failures).toEqual([
			"prompt.txt was sealed and is gone",
		]);
	});

	test("names an input that is new", () => {
		expect(
			check({
				inputs: { "prompt.txt": "sha256:aaa", "extra.txt": "sha256:ccc" },
			}).failures,
		).toEqual(["extra.txt is new since the stamp"]);
	});

	test("names a target model that is not the sealed one", () => {
		const suite = {
			...SUITE,
			target: { ...SUITE.target, models: ["anthropic/claude-sonnet-5"] },
		} as Suite;
		expect(check({ suite }).failures).toEqual([
			"target models changed: sealed anthropic/claude-haiku-4-5, now anthropic/claude-sonnet-5",
		]);
	});

	test("names a judge that is not the sealed one", () => {
		const suite = { ...SUITE, judges: ["anthropic/claude-haiku-5-5"] } as Suite;
		expect(check({ suite }).failures).toEqual([
			"judges changed: sealed anthropic/claude-sonnet-5, now anthropic/claude-haiku-5-5",
		]);
	});

	test("fails when the line was raised above the sealed pass rate", () => {
		const suite = {
			...SUITE,
			stamp: { inputs: ["prompt.txt"], minimum_pass_rate: 0.95 },
		} as Suite;
		expect(check({ suite }).failures).toEqual([
			"sealed pass rate 94.0% is under the line 95.0%",
		]);
	});

	test("warns, without failing, when the forge or promptfoo version differs", () => {
		const result = check({
			versions: { forge: "1.3.0", promptfoo: "0.124.0" },
		});
		expect(result.failures).toEqual([]);
		expect(result.warnings).toEqual([
			"sealed with llm-tests-forge 1.2.3, this is 1.3.0",
			"sealed from a promptfoo 0.123.0 run, the last run here is 0.124.0",
		]);
	});

	test("does not warn about promptfoo when the installed one is not known", () => {
		expect(
			check({ versions: { forge: "1.2.3", promptfoo: null } }).warnings,
		).toEqual([]);
	});

	test("lists every failure at once", () => {
		const result = check({ inputs: {} });
		const suite = { ...SUITE, judges: ["x/y"] } as Suite;
		expect(
			checkStamp({
				stamp: STAMP,
				current: {},
				suite,
				versions: { forge: "1.2.3", promptfoo: "0.123.0" },
			}).failures,
		).toHaveLength(2);
		expect(result.failures).toHaveLength(1);
	});
});

describe("requireStampBlock", () => {
	test("returns the block", () => {
		expect(requireStampBlock(SUITE)).toEqual(SUITE.stamp as never);
	});

	test("says what to write when the suite has none", () => {
		const { stamp: _stamp, ...withoutBlock } = SUITE;
		expect(() => requireStampBlock(withoutBlock as Suite)).toThrow(
			"suite.yaml has no stamp block; add stamp.inputs",
		);
	});
});

describe("buildStamp", () => {
	test("seals the run's numbers, the suite's models and the line, with the hash of the inputs", () => {
		const report = {
			...runOf([["a", "anthropic/claude-haiku-4-5", "flaky"]], 0.94),
			rows: 48,
			promptfooVersion: "0.123.0",
			ranAt: "2026-10-25T20:40:00.000Z",
			flaky: ["a @ anthropic/claude-haiku-4-5"],
		} as unknown as Report;
		const hashes = { "prompt.txt": "sha256:aaa" };
		expect(
			buildStamp({
				report,
				suite: SUITE,
				hashes,
				forgeVersion: "1.2.3",
				now: new Date("2026-10-25T21:00:00.000Z"),
			}),
		).toEqual({
			...STAMP,
			flaky: ["a @ anthropic/claude-haiku-4-5"],
		});
	});
});
