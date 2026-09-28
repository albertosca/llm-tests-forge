import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { CliContext } from "../../src/cli/context";
import { createContext } from "../../src/cli/context";
import { drafterFlag, run, USAGE } from "../../src/cli/main";
import {
	readCases,
	readFeature,
	readScenarios,
	readSuite,
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
} from "../../src/core/files";
import { FORGE_VERSION } from "../../src/core/version";

/** An unambiguously old timestamp: any real write resets a file's mtime to
 * "now", which is trivially distinguishable from this regardless of the
 * filesystem's mtime resolution — unlike comparing two mtimes taken moments
 * apart, which a coarse clock could report as equal by coincidence. */
const LONG_AGO = new Date("2000-01-01T00:00:00Z");

const MODEL = `fake/${resolve("tests/fixtures/cli-responses.json")}`;

async function ctxIn(cwd: string, stdinLines: string[] = []) {
	const out: string[] = [];
	const queue = [...stdinLines];
	const context = createContext({
		cwd,
		drafter: MODEL,
		stdin: async () => queue.shift() ?? "",
	});
	context.stdout = (line) => out.push(line);
	return { context, out };
}

/**
 * A real `$EDITOR`: a tiny script written into `directory` that rewrites
 * the file it is handed, substituting the whole line `from` for the whole
 * line `replacement`. `sed -i` is spelled differently on macOS and GNU, so
 * this writes through a temp file instead. Returns the script's path, for
 * `$EDITOR` to point at.
 */
async function editorReplacing(
	directory: string,
	from: string,
	replacement: string,
): Promise<string> {
	const path = join(directory, `fake-editor-${from.replace(/\W/g, "")}.sh`);
	await writeFile(
		path,
		`#!/bin/sh\nsed 's|^${from}$|${replacement}|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
	);
	await chmod(path, 0o755);
	return path;
}

describe("forge CLI end to end (fake provider)", () => {
	test("describe -> review -> scenarios -> review --all -> cases -> dedupe -> import", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");

		let { context, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], context),
		).toBe(0);
		expect((await readFeature(forgeDirectory)).status).toBe("pending");
		expect(out.at(-1)).toContain("feature.yaml");

		// scenarios refuse a pending feature
		({ context, out } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(1);
		expect(out.at(-1)).toContain("pending");

		// approve the feature through review
		({ context, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		expect((await readFeature(forgeDirectory)).status).toBe("approved");

		({ context, out } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		expect(await readScenarios(forgeDirectory)).toHaveLength(6);

		// cases refuse when no scenario is approved
		({ context, out } = await ctxIn(cwd));
		expect(
			await run(["cases", "--scenario", "polite-rejection"], context),
		).toBe(1);

		// approve one scenario with --all requires --scenario
		({ context, out } = await ctxIn(cwd));
		expect(await run(["review", "--all"], context)).toBe(2);
		({ context, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0); // first pending scenario approved, rest skipped by empty stdin
		const scenarios = await readScenarios(forgeDirectory);
		expect(scenarios[0]?.status).toBe("approved");

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["cases", "--scenario", "polite-rejection", "--n", "2"],
				context,
			),
		).toBe(0);
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["polite-rejection-01", "polite-rejection-02"]);

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(["dedupe", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(
			(await readCases(forgeDirectory, "polite-rejection"))[1]?.duplicate_of,
		).toBe("polite-rejection-01");

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).every(
				(caseEntry) => caseEntry.status === "approved",
			),
		).toBe(true);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		({ context, out } = await ctxIn(cwd));
		expect(await run(["import", jsonl], context)).toBe(0);
		expect(
			(await readCases(forgeDirectory, "imported")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["imported-01", "imported-02"]);
		expect(
			(await readScenarios(forgeDirectory)).some(
				(scenario) => scenario.id === "imported",
			),
		).toBe(true);
	});

	test("usage errors exit 2 and unknown verbs print usage", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context, out } = await ctxIn(cwd);
		expect(await run([], context)).toBe(2);
		expect(await run(["frobnicate"], context)).toBe(2);
		expect(out.join("\n")).toContain("usage:");
		// The two forms are mutually exclusive, and a bracket list said the
		// opposite until `--all --only` started being refused.
		expect(out.join("\n")).toContain(
			"review [--scenario id] [--only feature|scenarios|cases] | review --scenario id --all",
		);
	});

	test("--help, -h and help print the usage and exit 0; --version, -V and version print the version and exit 0", async () => {
		for (const flag of ["--help", "-h", "help"]) {
			const { context, out } = await ctxIn(
				await mkdtemp(join(tmpdir(), "forge-help-")),
			);
			expect(await run([flag], context)).toBe(0);
			expect(out.join("\n")).toContain("describe <text...>");
		}
		for (const flag of ["--version", "-V", "version"]) {
			const { context, out } = await ctxIn(
				await mkdtemp(join(tmpdir(), "forge-version-")),
			);
			expect(await run([flag], context)).toBe(0);
			expect(out).toEqual([FORGE_VERSION]);
		}
	});

	test("missing drafter is a usage error (exit 2) naming the flag", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const out: string[] = [];
		const context = createContext({ cwd, env: {}, stdin: async () => "" });
		context.stdout = (line) => out.push(line);
		expect(await run(["describe", "x"], context)).toBe(2);
		expect(out.at(-1)).toContain("--drafter");
	});

	test("the drafter comes from --drafter or FORGE_DRAFTER; the old --model and FORGE_MODEL are gone", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-drafter-"));
		const fromEnvironment = createContext({
			cwd: directory,
			env: { FORGE_DRAFTER: "fake/x" },
			stdin: async () => "",
		});
		expect(fromEnvironment.drafter).toBe("fake/x");
		const oldName = createContext({
			cwd: directory,
			env: { FORGE_MODEL: "fake/x" },
			stdin: async () => "",
		});
		expect(() => oldName.drafter).toThrow(
			"no drafter: pass --drafter provider/model or set FORGE_DRAFTER",
		);
		const { context, out } = await ctxIn(directory);
		expect(await run(["describe", "text", "--model", "fake/x"], context)).toBe(
			2,
		);
		expect(out.join("\n")).toContain("Unknown option '--model'");
	});

	test("every message that names a command says llm-tests-forge", async () => {
		expect(USAGE).toStartWith("usage: llm-tests-forge <verb>");
		expect(USAGE).not.toMatch(
			/(^|[\s`])forge (describe|scenarios|cases|dedupe|import|review|move|estimate|emit|report)\b/m,
		);
	});
});

describe("review: interactive decisions beyond --all", () => {
	test("reports nothing pending once the feature is approved and no scenarios or cases exist yet", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		({ context, out } = await ctxIn(cwd));
		expect(await run(["review"], context)).toBe(0);
		expect(out.at(-1)).toBe("review: nothing pending");
	});

	test("interactively approving a case asks for its expected value first, and an unanswered second case stays pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const { context: describeContext } = await ctxIn(cwd);
		expect(
			await run(
				["describe", "The bot classifies hiring emails"],
				describeContext,
			),
		).toBe(0);
		const { context: approveContext } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveContext)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		const { context: importContext } = await ctxIn(cwd);
		expect(await run(["import", jsonl], importContext)).toBe(0);

		// decision "approve" for imported-01, then its expected fields (oracle
		// is derived "fields" from the feature's json output); the queue then
		// drains for imported-02, which askChoice maps to "skip".
		const { context: reviewContext, out } = await ctxIn(cwd, [
			"approve",
			"type=rejection",
		]);
		expect(
			await run(
				["review", "--scenario", "imported", "--only", "cases"],
				reviewContext,
			),
		).toBe(0);

		const cases = await readCases(forgeDirectory, "imported");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["imported-01", "approved"],
			["imported-02", "pending"],
		]);
		expect(cases[0]?.expected).toEqual({ fields: { type: "rejection" } });
		// One case skipped; nothing else was pending in this scope.
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped, 0 re-opened, 1 still pending",
		);
	});
});

describe("review: only rewrites files a decision actually touched", () => {
	test("a scenario's case file with no pending items, and scenarios.yaml when no scenario was decided, are left untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");

		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);

		// Approve the first two scenarios (polite-rejection, huge-signature);
		// the rest are skipped by the drained stdin queue.
		({ context } = await ctxIn(cwd, ["approve", "approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		({ context } = await ctxIn(cwd));
		expect(
			await run(["cases", "--scenario", "polite-rejection"], context),
		).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["cases", "--scenario", "huge-signature"], context)).toBe(
			0,
		);

		// Fully decide huge-signature's cases so it carries no pending items
		// into the next review pass at all.
		({ context } = await ctxIn(cwd));
		expect(
			await run(["review", "--scenario", "huge-signature", "--all"], context),
		).toBe(0);

		const scenariosPath = join(forgeDirectory, "scenarios.yaml");
		const hugeCasesPath = join(forgeDirectory, "cases", "huge-signature.yaml");
		await utimes(scenariosPath, LONG_AGO, LONG_AGO);
		await utimes(hugeCasesPath, LONG_AGO, LONG_AGO);

		// --only cases means no scenario gets a decision this pass either
		// (four scenarios are still pending but are filtered out), and only
		// polite-rejection has a pending case for the single "approve" to land on.
		const { context: caseReviewContext, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "cases"], caseReviewContext)).toBe(0);
		// One case approved, one skipped, and the four scenarios --only
		// filtered out of this pass are still pending -- "skipped" alone
		// would have reported 1 and hidden the other four.
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped, 0 re-opened, 5 still pending",
		);

		// The touched file really was rewritten (proves the assertions below
		// are about an untouched file, not a no-op review pass).
		const politeCases = await readCases(forgeDirectory, "polite-rejection");
		expect(politeCases[0]?.status).toBe("approved");

		const scenariosStat = await stat(scenariosPath);
		expect(scenariosStat.mtime.getTime()).toBe(LONG_AGO.getTime());
		const hugeCasesStat = await stat(hugeCasesPath);
		expect(hugeCasesStat.mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("scenarios: --kinds restricts required coverage", () => {
	test("accepts a comma-separated kind list", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios", "--kinds", "happy"], context)).toBe(0);
		expect(await readScenarios(join(cwd, ".forge"))).toHaveLength(6);
	});

	test("rejects an unknown kind, naming the bad value and a valid one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		const { context: scenariosContext, out } = await ctxIn(cwd);
		expect(
			await run(["scenarios", "--kinds", "happy,bogus"], scenariosContext),
		).toBe(2);
		expect(out.at(-1)).toContain('"bogus"');
		expect(out.at(-1)).toContain("happy");
	});
});

describe("scenarios: --more validation (Finding 3)", () => {
	async function approvedFeature(cwd: string) {
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
	}

	test("rejects a non-numeric --more, naming the flag and the bad value", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["scenarios", "--more", "abc"], context)).toBe(2);
		expect(out.at(-1)).toContain("--more");
		expect(out.at(-1)).toContain('"abc"');
		expect(out.at(-1)).toContain("positive integer");
	});

	test("rejects a non-positive --more (embedding a literal NaN/0 into the model prompt is not acceptable)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["scenarios", "--more", "0"], context)).toBe(2);
		expect(out.at(-1)).toContain("--more");
		expect(out.at(-1)).toContain('"0"');
	});
});

describe("cases: scenario lookup failures", () => {
	// Both cases below need at least one real scenario on disk: an empty
	// `scenarios.yaml` would make the id/status filter a no-op over an
	// empty array, which "passes" without ever calling the filter's own
	// predicate — identical output for a working filter and a deleted one.
	async function withPendingScenarios(cwd: string) {
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
	}

	test("names the missing scenario when --scenario matches nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await withPendingScenarios(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["cases", "--scenario", "no-such-scenario"], context),
		).toBe(1);
		expect(out.at(-1)).toContain('scenario "no-such-scenario" not found');
		// The scenario id is carried in ForgeError's structured `details`,
		// not only interpolated into the message string -- ForgeError's own
		// constructor surfaces `details.id` as this "(id: ...)" suffix.
		expect(out.at(-1)).toContain("(id: no-such-scenario)");
	});

	test("refuses when no scenario is approved and none was named", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await withPendingScenarios(cwd); // scenarios exist but all remain pending

		const { context, out } = await ctxIn(cwd);
		expect(await run(["cases"], context)).toBe(1);
		expect(out.at(-1)).toContain("no approved scenario");
	});
});

describe("cases: --n validation (Finding 3)", () => {
	async function approvedScenario(cwd: string) {
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);
	}

	test("rejects a non-numeric --n, naming the flag and the bad value", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedScenario(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["cases", "--scenario", "polite-rejection", "--n", "abc"],
				context,
			),
		).toBe(2);
		expect(out.at(-1)).toContain("--n");
		expect(out.at(-1)).toContain('"abc"');
		expect(out.at(-1)).toContain("positive integer");
	});

	test("rejects a non-positive --n", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedScenario(cwd);

		// `--n -1` (as two args) is ambiguous to Node's own parseArgs (it
		// looks like a second flag) and gets rejected before ever reaching
		// our validator; `--n=0` is unambiguously a value and lands there.
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n=0"], context),
		).toBe(2);
		expect(out.at(-1)).toContain("--n");
		expect(out.at(-1)).toContain('"0"');
		expect(out.at(-1)).toContain("positive integer");
	});
});

describe("dedupe: --scenario existence check (Finding 1)", () => {
	test("fails naming the scenario instead of writing a phantom empty cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["dedupe", "--scenario", "totally-bogus"], context)).toBe(
			1,
		);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');

		const phantom = await stat(
			join(forgeDirectory, "cases", "totally-bogus.yaml"),
		).then(
			() => true,
			() => false,
		);
		expect(phantom).toBe(false);
	});
});

describe("review --all: --scenario existence check (Finding 1)", () => {
	test("fails naming the scenario instead of reporting a fake success", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "totally-bogus", "--all"], context),
		).toBe(1);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');

		const phantom = await stat(
			join(forgeDirectory, "cases", "totally-bogus.yaml"),
		).then(
			() => true,
			() => false,
		);
		expect(phantom).toBe(false);
	});
});

describe("review --all: never approves a case with no expected (Finding 2)", () => {
	test("imported cases (no expected by design) stay pending, and the summary names how many and why", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const { context: describeContext } = await ctxIn(cwd);
		expect(
			await run(
				["describe", "The bot classifies hiring emails"],
				describeContext,
			),
		).toBe(0);
		const { context: approveContext } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveContext)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		const { context: importContext } = await ctxIn(cwd);
		expect(await run(["import", jsonl], importContext)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "imported", "--all"], context),
		).toBe(0);

		const cases = await readCases(forgeDirectory, "imported");
		expect(cases.every((caseEntry) => caseEntry.status === "pending")).toBe(
			true,
		);
		expect(cases.every((caseEntry) => caseEntry.expected === undefined)).toBe(
			true,
		);
		expect(out.at(-1)).toBe(
			"review: approved 0 pending case(s) of imported; 2 left pending (no expected set — run `llm-tests-forge review --scenario imported` to fill them in)",
		);
	});

	test("in a mix, approves only the cases that have an expected and leaves the rest pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(
			await run(
				["cases", "--scenario", "polite-rejection", "--n", "2"],
				context,
			),
		).toBe(0);

		// Both generated cases have `expected` from the fixture; strip it
		// from the second to simulate a case that has none (error.g. hand-edited),
		// so this test proves the partial case, not just the all-or-nothing one.
		const generated = await readCases(forgeDirectory, "polite-rejection");
		const first = generated[0];
		const second = generated[1];
		if (!first || !second) throw new Error("expected two generated cases");
		const { expected: _expected, ...secondWithoutExpected } = second;
		await writeCases(forgeDirectory, "polite-rejection", [
			first,
			secondWithoutExpected,
		]);

		const { context: allContext, out } = await ctxIn(cwd);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--all"],
				allContext,
			),
		).toBe(0);

		const after = await readCases(forgeDirectory, "polite-rejection");
		expect(after[0]?.status).toBe("approved");
		expect(after[1]?.status).toBe("pending");
		expect(after[1]?.expected).toBeUndefined();
		expect(out.at(-1)).toBe(
			"review: approved 1 pending case(s) of polite-rejection; 1 left pending (no expected set — run `llm-tests-forge review --scenario polite-rejection` to fill them in)",
		);
	});
});

describe("review --only validation (Finding 4)", () => {
	test("rejects an unknown --only value instead of reporting a false 'nothing pending'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: describeContext } = await ctxIn(cwd);
		// A freshly described feature is pending -- genuinely pending work
		// exists, so "nothing pending" would be a lie here.
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "totally-bogus-kind"], context)).toBe(
			2,
		);
		expect(out.at(-1)).toContain('"totally-bogus-kind"');
		expect(out.at(-1)).not.toContain("nothing pending");
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	});
});

describe("review --all requires --scenario: message and exit code (Minor)", () => {
	test("exits 2 and does not leak the internal usage routing marker", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--all"], context)).toBe(2);
		expect(out.at(-1)).toBe("error: --all requires --scenario");
	});
});

describe("import: zero positional arguments (Minor)", () => {
	test("fails naming what is missing, instead of crashing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context, out } = await ctxIn(cwd);
		expect(await run(["import"], context)).toBe(2);
		expect(out.at(-1)).toContain("import needs a JSONL file path");
	});
});

describe("describe: --prompt-file missing", () => {
	test("fails cleanly with a ForgeError naming the file, instead of a raw ENOENT", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const missing = join(cwd, "missing-prompt.md");
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "text", "--prompt-file", missing], context),
		).toBe(1);
		expect(out.at(-1)).toContain("file not found");
		expect(out.at(-1)).toContain(missing);
	});
});

describe("import: missing file", () => {
	test("fails cleanly, naming the file, when the JSONL path does not exist", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);
		const { context: approveContext } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveContext)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		const missing = join(cwd, "nope.jsonl");
		expect(await run(["import", missing], context)).toBe(1);
		expect(out.at(-1)).toContain("file not found");
	});
});

describe("import: --oracle validation", () => {
	test("rejects an unknown oracle, naming the bad value and a valid one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"x"}\n');
		const { context, out } = await ctxIn(cwd);
		expect(await run(["import", jsonl, "--oracle", "bogus"], context)).toBe(2);
		expect(out.at(-1)).toContain('"bogus"');
		expect(out.at(-1)).toContain("label");
	});
});

describe("drafterFlag", () => {
	test("reads --drafter from raw argv", () => {
		expect(drafterFlag(["describe", "x", "--drafter", "anthropic/haiku"])).toBe(
			"anthropic/haiku",
		);
	});

	test("returns undefined when --drafter is absent", () => {
		expect(drafterFlag(["describe", "x"])).toBeUndefined();
	});
});

describe("run(): error classification", () => {
	test("an unrecognized option from parseArgs is reported as a usage error (exit 2)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context, out } = await ctxIn(cwd);
		expect(await run(["describe", "x", "--bogus"], context)).toBe(2);
		expect(out.at(-1)).toContain("usage:");
	});

	test("a non-programming-error that is neither a ForgeError nor a parseArgs TypeError is printed cleanly (exit 1), not thrown", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		// "edit" on the only pending item (the feature) drives openInEditor's
		// real Bun.spawn with a deliberately broken $EDITOR, which throws
		// synchronously (ENOENT) before there is any exit code to return.
		// That's neither a ForgeError nor parseArgs's TypeError, and it is
		// not a programming-error type either (it's a plain Error carrying
		// a NodeJS.ErrnoException .code) -- so run() now catches it and
		// prints the same clean `error: ...` line a real user gets for any
		// other external failure, instead of dumping Bun's raw ENOENT stack.
		const { context, out } = await ctxIn(cwd, ["edit"]);
		const originalEditor = process.env.EDITOR;
		process.env.EDITOR = "totally-bogus-editor-that-does-not-exist";
		try {
			expect(await run(["review"], context)).toBe(1);
			expect(out.at(-1)).toBe(
				'error: Executable not found in $PATH: "totally-bogus-editor-that-does-not-exist"',
			);
		} finally {
			if (originalEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = originalEditor;
		}
	});

	test("a provider/network failure from Llm.generate (non-ForgeError) is printed cleanly (exit 1), not thrown", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context, out } = await ctxIn(cwd);
		context.llm = {
			generate: async () => {
				throw new Error("This model is currently experiencing high demand.");
			},
		};
		expect(await run(["describe", "text"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			"error: This model is currently experiencing high demand.",
		);
	});

	test("a genuine programming error (TypeError) still propagates with its real stack, even from Llm.generate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context } = await ctxIn(cwd);
		context.llm = {
			generate: async () => {
				throw new TypeError("Cannot read properties of undefined");
			},
		};
		let caughtError: unknown;
		try {
			await run(["describe", "text"], context);
		} catch (error) {
			caughtError = error;
		}
		expect(caughtError).toBeInstanceOf(TypeError);
	});
});

describe("createContext defaults", () => {
	test("the default stdout writes through console.log", () => {
		const original = console.log;
		const lines: string[] = [];
		console.log = (line: string) => lines.push(line);
		try {
			const context = createContext({
				cwd: "/tmp",
				env: { FORGE_DRAFTER: "fake/x" },
				stdin: async () => "",
			});
			context.stdout("hello");
		} finally {
			console.log = original;
		}
		expect(lines).toEqual(["hello"]);
	});
});

describe("the downstream gate: nothing runs on a pending feature (whole-branch Finding 1)", () => {
	/** A freshly described feature, left pending on purpose. */
	async function pendingFeature(cwd: string) {
		const { context } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], context),
		).toBe(0);
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	}

	/** Refuses loudly if the verb reaches the model at all. */
	function noModelCalls(context: Awaited<ReturnType<typeof ctxIn>>["context"]) {
		context.llm = {
			generate: async () => {
				throw new Error("the model was called for a pending feature");
			},
		};
	}

	test("scenarios refuses, naming feature.yaml and the feature id", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		noModelCalls(context);
		expect(await run(["scenarios"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`llm-tests-forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		);
	});

	test("cases refuses before spending a single token", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		noModelCalls(context);
		expect(await run(["cases"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`llm-tests-forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		);
	});

	test("import refuses instead of exiting 0, and writes no cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);
		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n');

		const { context, out } = await ctxIn(cwd);
		expect(await run(["import", jsonl], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`llm-tests-forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		);
		const wrote = await stat(
			join(cwd, ".forge", "cases", "imported.yaml"),
		).then(
			() => true,
			() => false,
		);
		expect(wrote).toBe(false);
	});
});

describe("describe never destroys a reviewed feature (whole-branch Finding 2)", () => {
	/** Describes a feature and approves it, so the next describe is destructive. */
	async function approvedFeature(cwd: string) {
		let { context } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], context),
		).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("approved");
	}

	test("refuses, names the file and how to override, and leaves the file byte-identical", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const featurePath = join(cwd, ".forge", "feature.yaml");
		await approvedFeature(cwd);
		// A hand-added invariant: the input this refusal exists to protect.
		const reviewed = await readFile(featurePath, "utf8");
		await writeFile(
			featurePath,
			`${reviewed}invariants_note: never auto-generated\n`,
		);
		const before = await readFile(featurePath, "utf8");
		await utimes(featurePath, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["describe", "something else entirely"], context)).toBe(1);
		expect(out.at(-1)).toContain(
			'feature "classify-email" is already approved',
		);
		expect(out.at(-1)).toContain("--force");
		expect(out.at(-1)).toContain(featurePath);
		expect(await readFile(featurePath, "utf8")).toBe(before);
		expect((await stat(featurePath)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});

	test("--force does overwrite it, back to pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "--force", "something else entirely"], context),
		).toBe(0);
		expect(out.at(-1)).toContain("written as pending");
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	});

	test("a still-pending feature is not reviewed work, so re-describing over it is allowed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: first } = await ctxIn(cwd);
		expect(await run(["describe", "text"], first)).toBe(0);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["describe", "text again"], context)).toBe(0);
		expect(out.at(-1)).toContain("written as pending");
	});
});

describe("review: an edit that renames an item lands on disk (whole-branch Finding 3)", () => {
	async function withEditor<T>(
		path: string,
		body: () => Promise<T>,
	): Promise<T> {
		const original = process.env.EDITOR;
		process.env.EDITOR = path;
		try {
			return await body();
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
	}

	/** describe -> approve -> scenarios, leaving six pending scenarios. */
	async function pendingScenarios(cwd: string) {
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
	}

	async function approvedScenarioWithTwoCases(cwd: string) {
		await pendingScenarios(cwd);
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(
			await run(
				["cases", "--scenario", "polite-rejection", "--n", "2"],
				context,
			),
		).toBe(0);
	}

	test("renaming a scenario is refused by name and re-asked, and the next review pass still works", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		// The scenario has to be pending to be offered, and has to have
		// cases for the rename to be able to orphan them.
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);
		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection",
			"id: polite-rejection-fixed",
		);

		// "edit" is refused, the same item is re-asked, and the drained
		// queue then answers "" -- which askChoice maps to skip.
		const { context, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review", "--only", "scenarios"], context)).toBe(0);
		});

		expect(out).toContain(
			`cannot apply: a scenario's id cannot be changed in review (from "polite-rejection" to "polite-rejection-fixed"): it names .forge/cases/<id>.yaml; run \`llm-tests-forge move --scenario polite-rejection polite-rejection-fixed\` (id: polite-rejection)`,
		);
		const scenarios = await readScenarios(forgeDirectory);
		expect(scenarios.map((scenario) => [scenario.id, scenario.status])).toEqual(
			[["polite-rejection", "pending"]],
		);

		// The half-applied rename used to leave every case of that scenario
		// naming an id scenarios.yaml no longer held, which the next pass
		// refused wholesale. A second run still offers them.
		const { context: nextContext, out: nextOut } = await ctxIn(cwd, [
			"approve",
		]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				nextContext,
			),
		).toBe(0);
		expect(nextOut).toContain("--- case polite-rejection-01 ---");
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map(
				(caseEntry) => caseEntry.status,
			),
		).toEqual(["approved", "pending"]);
	});

	test("a renamed case is written back under its new id, in its own file, with no second file invented", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await approvedScenarioWithTwoCases(cwd);
		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection-01",
			"id: polite-rejection-42",
		);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					context,
				),
			).toBe(0);
		});

		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["polite-rejection-42", "edited"],
			["polite-rejection-02", "pending"],
		]);
		expect(await readdir(join(forgeDirectory, "cases"))).toEqual([
			"polite-rejection.yaml",
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 1 skipped, 0 re-opened, 1 still pending",
		);
	});

	test("changing a case's scenario is refused by name and re-asked, inventing no cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await approvedScenarioWithTwoCases(cwd);
		const editor = await editorReplacing(
			cwd,
			"scenario: polite-rejection",
			"scenario: huge-signature",
		);

		// "edit" is refused, the same item is re-asked, and the drained
		// queue then answers "" -- which askChoice maps to skip.
		const { context, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					context,
				),
			).toBe(0);
		});

		expect(
			out.some(
				(line) =>
					line ===
					`cannot apply: a case's scenario cannot be changed in review (from "polite-rejection" to "huge-signature"); run \`llm-tests-forge move --case polite-rejection-01 --to huge-signature\` (id: polite-rejection-01)`,
			),
		).toBe(true);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(
			cases.map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
				caseEntry.status,
			]),
		).toEqual([
			["polite-rejection-01", "polite-rejection", "pending"],
			["polite-rejection-02", "polite-rejection", "pending"],
		]);
		expect(await readdir(join(forgeDirectory, "cases"))).toEqual([
			"polite-rejection.yaml",
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 0 edited, 2 skipped, 0 re-opened, 2 still pending",
		);
	});
});

describe("review: --only that filters everything out says so", () => {
	test("does not report 'nothing pending' while six scenarios are pending outside the filter", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);

		// The feature is approved, so nothing of kind `feature` is pending --
		// but six scenarios are.
		const { context: onlyContext, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "feature"], onlyContext)).toBe(0);
		expect(out.at(-1)).toBe(
			"review: nothing pending matching --only feature; 6 item(s) still pending outside that filter",
		);
	});
});

describe("review --scenario is checked on the interactive path too (whole-branch Finding 4)", () => {
	test("a typo names the unknown scenario and exits 1, instead of 'nothing pending' and 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);

		// Six scenarios really are pending here, so "nothing pending" was
		// not only unhelpful, it was false.
		const { context: reviewContext, out } = await ctxIn(cwd);
		expect(
			await run(
				["review", "--scenario", "polite-rejection-typo"],
				reviewContext,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "polite-rejection-typo" not found (id: polite-rejection-typo)',
		);
		expect(out.join("\n")).not.toContain("nothing pending");
	});

	test("the same typo is refused with --only, which is parsed before it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		const { context: reviewContext, out } = await ctxIn(cwd);
		expect(
			await run(
				["review", "--scenario", "totally-bogus", "--only", "cases"],
				reviewContext,
			),
		).toBe(1);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');
	});
});

describe("dedupe never writes a phantom empty cases file (whole-branch Finding 5)", () => {
	/** describe -> approve -> scenarios, so real scenarios exist with no cases. */
	async function scenariosWithoutCases(cwd: string) {
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
	}

	test("a known scenario with no cases yet is named, not written as an empty list", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await scenariosWithoutCases(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["dedupe", "--scenario", "polite-rejection"], context),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "polite-rejection" has no cases yet; run `llm-tests-forge cases --scenario polite-rejection` first (id: polite-rejection)',
		);
		expect(out.join("\n")).not.toContain("0 marked as duplicates");

		const casesDirectory = await readdir(join(forgeDirectory, "cases")).catch(
			() => [] as string[],
		);
		expect(casesDirectory).toEqual([]);
	});

	test("with no cases file anywhere, bare dedupe refuses instead of exiting 0 having done nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await scenariosWithoutCases(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["dedupe"], context)).toBe(1);
		expect(out.at(-1)).toContain("no cases to dedupe");
		expect(out.at(-1)).toContain(join(cwd, ".forge", "cases"));
	});
});

describe("review holds the human to the same oracle contract as the model (whole-branch Finding 6)", () => {
	test("a label outside the feature's labels is refused by name and re-asked, and only the valid one is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], context),
		).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		// --oracle label pins the imported scenario to the label oracle, the
		// one the feature's `labels` list constrains.
		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		({ context } = await ctxIn(cwd));
		expect(await run(["import", jsonl, "--oracle", "label"], context)).toBe(0);

		const { context: reviewContext, out } = await ctxIn(cwd, [
			"approve",
			"maybe",
			"rejection",
		]);
		expect(
			await run(
				["review", "--scenario", "imported", "--only", "cases"],
				reviewContext,
			),
		).toBe(0);

		expect(out).toContain(
			`label "maybe" is not one of the feature's labels; try again`,
		);
		const cases = await readCases(forgeDirectory, "imported");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["imported-01", "approved"],
			["imported-02", "pending"],
		]);
		expect(cases[0]?.expected).toEqual({ label: "rejection" });
		expect(cases[1]?.expected).toBeUndefined();
	});
});

describe("review: an expected already on disk is held to the oracle too", () => {
	test("approving a case whose label is not one of the feature's labels is refused and the file is left alone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		// A hand-written cases file: the label was never checked against
		// the feature on its way in.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "maybe" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		// "approve" is refused, the item is re-asked, and the drained queue
		// answers "" -- which askChoice maps to skip.
		const { context: reviewContext, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				reviewContext,
			),
		).toBe(0);

		expect(out).toContain(
			'cannot apply: expected does not match the oracle: label "maybe" is not one of the feature\'s labels (id: polite-rejection-01)',
		);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["polite-rejection-01", "pending"],
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 0 edited, 1 skipped, 0 re-opened, 1 still pending",
		);
	});
});

describe("review --all does not bulk-approve past the oracle", () => {
	test("a case whose label is not one of the feature's labels stays pending, named in the output", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		// One good case and one whose label the feature never declared.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "maybe" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context: allContext, out } = await ctxIn(cwd);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--all"],
				allContext,
			),
		).toBe(0);

		expect(out).toContain(
			`review: polite-rejection-02: label "maybe" is not one of the feature's labels`,
		);
		expect(out.at(-1)).toBe(
			"review: approved 1 pending case(s) of polite-rejection; 1 left pending (expected does not match the label oracle — see above)",
		);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["polite-rejection-01", "approved"],
			["polite-rejection-02", "pending"],
		]);
	});
});

describe("review: a decision applies to at most one entry (regression)", () => {
	test("two cases sharing an id: approving one leaves the other intact, with its own fields and status", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		// A cases file where two entries carry the same id -- the state the
		// review loop must not resolve by writing one decision over both.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the first one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the second one" },
				expected: { label: "acknowledgement" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context: reviewContext, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				reviewContext,
			),
		).toBe(0);
		// Only one item is offered: pendingItems places one entry per id, so
		// the twin is not reviewed this pass. That is a limitation, not the
		// defect under test -- the defect is what happens to it on write.
		// The count is taken on disk, so the twin still shows as pending.
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 1 still pending",
		);

		// Length alone would pass against a YAML alias: assert the second
		// entry's own content and its own status survived.
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(
			cases.map((caseEntry) => [caseEntry.input.email, caseEntry.status]),
		).toEqual([
			["the first one", "approved"],
			["the second one", "pending"],
		]);
		expect(cases[1]?.expected).toEqual({ label: "acknowledgement" });
		// Two distinct objects, not one written twice.
		expect(cases[0]).not.toBe(cases[1]);
		const raw = await readFile(
			join(forgeDirectory, "cases", "polite-rejection.yaml"),
			"utf8",
		);
		expect(raw).not.toContain("*");
		expect(raw).not.toContain("&");
	});
});

describe("review: a write-back never recreates a cases file removed during the pass", () => {
	test("the file is deleted before answering approve: the decision is not written back, and the removal is reported", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		// `ctxIn` scripts stdin from a fixed queue of lines; here the answer
		// itself has to remove the file first, so the context is built by
		// hand with a `stdin` that does both.
		const out: string[] = [];
		const removingContext = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => {
				await unlink(casesPath);
				return "approve";
			},
		});
		removingContext.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				removingContext,
			),
		).toBe(0);

		expect(out).toContain(
			"review: cases/polite-rejection.yaml was removed during the pass; its decisions were not written",
		);
		await expect(stat(casesPath)).rejects.toThrow();
	});
});

describe("review: a write-back guard also skips a cases file recreated during the pass", () => {
	test("the file is removed and rewritten with different content before answering approve: the outside content survives, and the line names what happened", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);

		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		// Existence alone would miss this: the path is there again by the
		// time the write-back looks, holding a different file entirely --
		// the one a person or another process put there while this pass
		// was still open, not the one this pass read at the start.
		const outsideContent =
			"# written by someone else while the pass was open\n[]\n";
		const out: string[] = [];
		const removingContext = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => {
				await unlink(casesPath);
				await writeFile(casesPath, outsideContent, "utf8");
				return "approve";
			},
		});
		removingContext.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				removingContext,
			),
		).toBe(0);

		expect(out).toContain(
			"review: cases/polite-rejection.yaml changed on disk during the pass; its decisions were not written",
		);
		const survived = await readFile(casesPath, "utf8");
		expect(survived).toBe(outsideContent);
	});
});

describe("review: a write-back guard skips just the files it cannot trust, and says how many decisions were not written", () => {
	test("two cases files decided, one removed during the pass: its decision is not written, the other's is, and the summary names the gap", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);

		// Sorted before "polite-rejection", so it is offered -- and
		// removed -- first; the second file's decision has to land
		// regardless of what happened to the first.
		await writeCases(forgeDirectory, "huge-signature", [
			{
				id: "huge-signature-01",
				scenario: "huge-signature",
				input: { email: "three" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const hugeSignaturePath = join(
			forgeDirectory,
			"cases",
			"huge-signature.yaml",
		);
		let questionsAnswered = 0;
		const out: string[] = [];
		const removingContext = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => {
				questionsAnswered += 1;
				// Removed while answering the second question -- after its
				// own decision, but before the write-back for either file
				// runs, since every write-back waits for the whole loop.
				if (questionsAnswered === 2) await unlink(hugeSignaturePath);
				return "approve";
			},
		});
		removingContext.stdout = (line) => out.push(line);

		expect(await run(["review", "--only", "cases"], removingContext)).toBe(0);

		expect(out).toContain(
			"review: cases/huge-signature.yaml was removed during the pass; its decisions were not written",
		);
		expect(out.at(-1)).toBe(
			"review: 2 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending; 1 decision(s) not written",
		);
		await expect(stat(hugeSignaturePath)).rejects.toThrow();
		const politeRejection = await readCases(forgeDirectory, "polite-rejection");
		expect(
			politeRejection.map((caseEntry) => [caseEntry.id, caseEntry.status]),
		).toEqual([["polite-rejection-01", "approved"]]);
	});
});

describe("review: onInteractivePass arms end-of-input only for the interactive path", () => {
	test("the interactive path calls it exactly once, before the loop asks its first question", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		let interactivePassCalls = 0;
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => "approve",
			onInteractivePass: () => {
				interactivePassCalls += 1;
			},
		});
		context.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);

		expect(interactivePassCalls).toBe(1);
	});

	test("--all never calls it: it asks nothing, so an interrupt during its model calls must not be mistaken for the middle of a review pass", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		let interactivePassCalls = 0;
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => "",
			onInteractivePass: () => {
				interactivePassCalls += 1;
			},
		});
		context.stdout = (line) => out.push(line);

		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);

		expect(interactivePassCalls).toBe(0);
	});
});

describe("review: an edit cannot rename an item onto an id already in its file", () => {
	async function withEditor<T>(
		path: string,
		body: () => Promise<T>,
	): Promise<T> {
		const original = process.env.EDITOR;
		process.env.EDITOR = path;
		try {
			return await body();
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
	}

	test("renaming a scenario onto a sibling's id is refused as a scenario rename, not as a collision", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);

		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection",
			"id: huge-signature",
		);
		const { context: reviewContext, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review", "--only", "scenarios"], reviewContext)).toBe(
				0,
			);
		});

		// A scenario's id cannot be changed to anything, so "pick an id
		// nothing else uses" was advice no free id could satisfy: the
		// refusal a person can act on is the one that names the file move.
		expect(out).toContain(
			'cannot apply: a scenario\'s id cannot be changed in review (from "polite-rejection" to "huge-signature"): it names .forge/cases/<id>.yaml; run `llm-tests-forge move --scenario polite-rejection huge-signature` (id: polite-rejection)',
		);
		expect(out.join("\n")).not.toContain("pick an id nothing else uses");
		const scenarios = await readScenarios(join(cwd, ".forge"));
		expect(scenarios.map((scenario) => [scenario.id, scenario.status])).toEqual(
			[
				["polite-rejection", "pending"],
				["huge-signature", "pending"],
				["ack-quiz", "pending"],
				["newsletter", "pending"],
				["injection", "pending"],
				["portuguese", "pending"],
			],
		);
	});

	test("the feature has no siblings, so editing it is not blocked by its own id", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context: describeContext } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeContext)).toBe(0);

		const editor = await editorReplacing(
			cwd,
			"purpose: Classify a hiring-process email",
			"purpose: Classify a hiring-process email, reviewed by hand",
		);
		const { context, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review"], context)).toBe(0);
		});

		const feature = await readFeature(join(cwd, ".forge"));
		expect(feature.purpose).toBe(
			"Classify a hiring-process email, reviewed by hand",
		);
		expect(feature.status).toBe("edited");
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});
});

const FEATURE = {
	id: "classify-email",
	purpose: "Classify a hiring email",
	inputs: [{ name: "email", kind: "text" as const }],
	output: { kind: "label" as const, labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved" as const,
};
const SUITE = {
	target: {
		kind: "python" as const,
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5"],
	},
	judges: ["google/gemini-3.5-flash"],
	repeat: 2,
	include: [],
};

async function forgeWithApprovedCases(cwd: string) {
	const forgeDirectory = join(cwd, ".forge");
	await writeFeature(forgeDirectory, FEATURE);
	await writeScenarios(forgeDirectory, [
		{
			id: "polite-rejection",
			kind: "happy",
			oracle: "label",
			description: "d",
			status: "approved",
		},
		{
			id: "vague-rubric",
			kind: "ambiguous",
			oracle: "rubric",
			description: "d",
			status: "approved",
		},
	]);
	await writeCases(forgeDirectory, "polite-rejection", [
		{
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "We will not proceed." },
			expected: { label: "rejection" },
			status: "approved",
			generated_by: "t",
		},
	]);
	await writeCases(forgeDirectory, "vague-rubric", [
		{
			id: "vague-rubric-01",
			scenario: "vague-rubric",
			input: { email: "Thanks for applying!" },
			expected: { rubric: "says it is an automated receipt" },
			status: "edited",
			generated_by: "t",
		},
	]);
	await writeSuite(forgeDirectory, SUITE);
	return forgeDirectory;
}

/**
 * A forge whose feature is approved and whose single `polite-rejection`
 * scenario is approved, without the six scenarios the `scenarios` verb
 * would generate — the starting point for the review decisions below.
 */
async function forgeWithApprovedScenario(
	cwd: string,
	oracle: "label" | "rubric" = "label",
) {
	const forgeDirectory = join(cwd, ".forge");
	await writeFeature(forgeDirectory, FEATURE);
	await writeScenarios(forgeDirectory, [
		{
			id: "polite-rejection",
			kind: "happy",
			oracle,
			description: "d",
			status: "approved",
		},
	]);
	return forgeDirectory;
}

describe("review --all checks that every case in the file belongs to it", () => {
	test("a case naming another scenario exits 1, names the move that fixes it, and leaves the file untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		// `--all` approves every pending case in the file against the
		// oracle of the scenario the file is named for. A case that names
		// another scenario is held to an oracle that is not its own.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "huge-signature",
				input: { email: "two" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);
		const casesFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(casesFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(1);

		expect(out.at(-1)).toBe(
			`error: case polite-rejection-02 names scenario "huge-signature" but lives in ${casesFile}; run \`llm-tests-forge move --case polite-rejection-02 --to huge-signature\` or fix the file (file: ${casesFile}, id: polite-rejection-02)`,
		);
		// Checked before the first write: the sibling that would have been
		// approved is still pending, and the file was never rewritten.
		expect((await stat(casesFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map(
				(caseEntry) => caseEntry.status,
			),
		).toEqual(["pending", "pending"]);
	});

	test("every case naming the file's own scenario is approved as before", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);
		expect(out.at(-1)).toBe(
			"review: approved 1 pending case(s) of polite-rejection",
		);
	});
});

describe("review names a case whose scenario is missing instead of asking for a rubric", () => {
	test("exits 1 naming the case and the scenario it points at, and decides nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		// The file is named for a scenario that exists; the case inside
		// points at one that does not. `oracleOf` used to answer "rubric"
		// here and ask the person for a rubric sentence for a case whose
		// oracle nobody knows.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "ghost",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: case polite-rejection-01 names scenario "ghost", which is not in scenarios.yaml (file: ${join(forgeDirectory, "scenarios.yaml")}, id: polite-rejection-01)`,
		);
		// Refused before the first prompt, so nothing was asked and nothing
		// was written: a broken file is not a decision to retry.
		expect(out.some((line) => line.includes("rubric sentence"))).toBe(false);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => caseEntry.status)).toEqual(["pending"]);
	});
});

describe("import --oracle cannot silently change an existing imported scenario", () => {
	/** An approved feature and one JSONL line, ready to import. */
	async function importable(cwd: string, name: string, email: string) {
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		const path = join(cwd, name);
		await writeFile(path, `${JSON.stringify({ email })}\n`);
		return { forgeDirectory, path };
	}

	test("a second import with a different --oracle exits 1 naming the oracle on disk, and writes no case", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { forgeDirectory, path } = await importable(cwd, "prod.jsonl", "one");
		// `rubric` is not what this feature derives (its output is a label),
		// so the scenario on disk proves the first --oracle was honoured.
		const { context: firstContext } = await ctxIn(cwd);
		expect(
			await run(["import", path, "--oracle", "rubric"], firstContext),
		).toBe(0);

		const second = join(cwd, "more.jsonl");
		await writeFile(second, '{"email":"two"}\n');
		const { context, out } = await ctxIn(cwd);
		expect(await run(["import", second, "--oracle", "label"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "imported" already exists with oracle rubric; --oracle cannot change it — edit .forge/scenarios.yaml (file: ${join(forgeDirectory, "scenarios.yaml")}, id: imported)`,
		);
		// Refused before any write: the second line did not land, and the
		// scenario still carries the oracle its cases were reviewed against.
		expect(
			(await readCases(forgeDirectory, "imported")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["imported-01"]);
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => scenario.oracle),
		).toEqual(["rubric"]);
	});

	test("a second import repeating the same --oracle is accepted and imports its line", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { forgeDirectory, path } = await importable(cwd, "prod.jsonl", "one");
		const { context: firstContext } = await ctxIn(cwd);
		expect(
			await run(["import", path, "--oracle", "rubric"], firstContext),
		).toBe(0);

		const second = join(cwd, "more.jsonl");
		await writeFile(second, '{"email":"two"}\n');
		const { context, out } = await ctxIn(cwd);
		expect(await run(["import", second, "--oracle", "rubric"], context)).toBe(
			0,
		);
		expect(out.at(-1)).toContain("1 new pending cases");
		expect(
			(await readCases(forgeDirectory, "imported")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["imported-01", "imported-02"]);
	});
});

describe("review --all refuses --only instead of parsing it and ignoring it", () => {
	test("exits 2 naming both flags, and the case --all would have approved stays pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				[
					"review",
					"--scenario",
					"polite-rejection",
					"--all",
					"--only",
					"cases",
				],
				context,
			),
		).toBe(2);
		expect(out.at(-1)).toContain("--all");
		expect(out.at(-1)).toContain("--only");
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => caseEntry.status)).toEqual(["pending"]);
	});
});

describe("review: a decision taken in this pass is visible to the rest of it", () => {
	/**
	 * A real `$EDITOR` that duplicates the line matching `line`, replacing
	 * `from` with `to` in the copy — an append that keeps the original
	 * line's indentation, whatever it is. `sed` cannot portably insert a
	 * newline in a replacement (BSD and GNU disagree), so this uses awk.
	 */
	async function editorAppendingLabel(
		directory: string,
		from: string,
		replacement: string,
	) {
		const path = join(directory, "fake-editor-label.sh");
		await writeFile(
			path,
			`#!/bin/sh\nawk '/${from}$/ { print; sub(/${from}$/, "${replacement}"); print; next } { print }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

	test("a label added by editing the feature is accepted for a case approved later in the same pass", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, {
			...FEATURE,
			output: { kind: "label", labels: ["rejection"] },
			status: "pending",
		});
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "shortlist" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const editor = await editorAppendingLabel(
			cwd,
			"- rejection",
			"- shortlist",
		);
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		// The feature is pending, so it is offered first: "edit" adds the
		// label, then "approve" lands on the case that uses it.
		const { context, out } = await ctxIn(cwd, ["edit", "approve"]);
		try {
			expect(await run(["review"], context)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}

		expect((await readFeature(forgeDirectory)).output.labels).toEqual([
			"rejection",
			"shortlist",
		]);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => caseEntry.status)).toEqual(["approved"]);
		// Refused against the feature as it was read off disk, the case
		// would have been re-asked and then skipped by the drained queue.
		expect(
			out.some((line) => line.includes('label "shortlist" is not one of')),
		).toBe(false);
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});
});

describe("review: editing a scenario's oracle re-opens the cases it invalidates", () => {
	async function withEditor<T>(path: string, body: () => Promise<T>) {
		const original = process.env.EDITOR;
		process.env.EDITOR = path;
		try {
			return await body();
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
	}

	/** One pending `label` scenario, reviewed with a scripted "edit" that
	 * turns it into a `rubric` one. */
	async function editOracleToRubric(
		cwd: string,
		out: string[],
		context: CliContext,
	) {
		const editor = await editorReplacing(
			cwd,
			"oracle: label",
			"oracle: rubric",
		);
		await withEditor(editor, async () => {
			expect(await run(["review"], context)).toBe(0);
		});
		return out;
	}

	test("two approved label cases go back to pending, keep their expected, and the change is reported", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "acknowledgement" },
				status: "edited",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, context);

		expect((await readScenarios(forgeDirectory))[0]?.oracle).toBe("rubric");
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => caseEntry.status)).toEqual([
			"pending",
			"pending",
		]);
		// The expected is kept, not thrown away: it is the reviewer's own
		// answer, and what it has to be rewritten into is up to them.
		expect(cases.map((caseEntry) => caseEntry.expected)).toEqual([
			{ label: "rejection" },
			{ label: "acknowledgement" },
		]);
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; 2 case(s) re-opened — edit each to give it an expected the new oracle accepts",
		);
		// One scenario was pending and was decided, so the pass itself left
		// nothing pending — the two it reports are the two it re-opened.
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 2 re-opened, 2 still pending",
		);
	});
	test("an oracle change whose cases file changed on disk during the pass re-opens nothing: no re-opened line or count, and still pending matches the disk", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		const approvedCases = [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "approved" as const,
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "acknowledgement" },
				status: "approved" as const,
				generated_by: "hand",
			},
		];
		await writeCases(forgeDirectory, "polite-rejection", approvedCases);
		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			// The only answer is the scenario's "edit"; before giving it, the
			// cases file is rewritten by "someone else" and dated long ago, so
			// the write-back guard cannot mistake it for the file it read.
			stdin: async () => {
				await writeCases(forgeDirectory, "polite-rejection", approvedCases);
				await utimes(casesPath, LONG_AGO, LONG_AGO);
				return "edit";
			},
		});
		context.stdout = (line) => out.push(line);
		await editOracleToRubric(cwd, out, context);

		expect(out).toContain(
			"review: cases/polite-rejection.yaml changed on disk during the pass; its decisions were not written",
		);
		expect(out.some((line) => line.includes("case(s) re-opened"))).toBe(false);
		// Nothing was re-opened on disk: both cases are still approved, and
		// the one pending scenario was decided, so nothing is pending.
		const onDisk = await readCases(forgeDirectory, "polite-rejection");
		expect(onDisk.map((caseEntry) => caseEntry.status)).toEqual([
			"approved",
			"approved",
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});

	test("a case whose expected already fits the new oracle stays approved, and a rejected one is not re-opened", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { rubric: "says it is a rejection" },
				status: "approved",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				status: "approved",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-03",
				scenario: "polite-rejection",
				input: { email: "three" },
				expected: { label: "rejection" },
				status: "rejected",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, context);

		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(cases.map((caseEntry) => [caseEntry.id, caseEntry.status])).toEqual([
			["polite-rejection-01", "approved"],
			["polite-rejection-02", "pending"],
			["polite-rejection-03", "rejected"],
		]);
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; 1 case(s) re-opened — edit each to give it an expected the new oracle accepts",
		);
	});

	test("an oracle change that invalidates nothing reports zero and leaves the cases file untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { rubric: "says it is a rejection" },
				status: "approved",
				generated_by: "hand",
			},
		]);
		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(casesPath, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, context);

		expect((await readScenarios(forgeDirectory))[0]?.oracle).toBe("rubric");
		// Nothing was re-opened, so there is nothing to go and edit: the
		// line ends at the count rather than instructing the person to edit
		// each of no cases.
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; 0 case(s) re-opened",
		);
		// No case changed, so the file no decision touched is not rewritten.
		expect((await stat(casesPath)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});

	test("a scenario edited before `cases` ever ran for it reports the change with no cases file to walk", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, context);

		expect((await readScenarios(forgeDirectory))[0]?.oracle).toBe("rubric");
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; no cases yet",
		);
		// The re-open line is the other half of the same pair: with no file
		// to walk there is no count to report, and both lines would be one
		// change announced twice.
		expect(out.some((line) => line.includes("case(s) re-opened"))).toBe(false);
		// Nothing generated a cases file, and reporting the change does not.
		expect(await readdir(forgeDirectory)).not.toContain("cases");
	});

	test("an empty cases file reports the change the same way and is left exactly as it was", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		// A file that exists and holds nothing: `listCaseScenarios` finds it,
		// so the re-open pass walks it, unlike the test above.
		await writeCases(forgeDirectory, "polite-rejection", []);
		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(casesPath, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, context);

		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; no cases yet",
		);
		expect(out.some((line) => line.includes("case(s) re-opened"))).toBe(false);
		expect((await stat(casesPath)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("review: what a rename does to the pointers at it, and what a twin id does to the pass", () => {
	test("a case renamed in review takes every duplicate_of pointing at it along, in the same write", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
				duplicate_of: "polite-rejection-01",
			},
		]);

		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection-01",
			"id: polite-rejection-42",
		);
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		// "edit" renames the first case; the drained queue then skips the
		// second, so nothing but the rename touches it.
		const { context } = await ctxIn(cwd, ["edit"]);
		try {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					context,
				),
			).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}

		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(
			cases.map((caseEntry) => [caseEntry.id, caseEntry.duplicate_of]),
		).toEqual([
			["polite-rejection-42", undefined],
			["polite-rejection-02", "polite-rejection-42"],
		]);
		// The pointer moved, the skipped case was not otherwise decided.
		expect(cases.map((caseEntry) => caseEntry.status)).toEqual([
			"edited",
			"pending",
		]);
	});

	test("review --all says it too: the twin is not a property of the interactive path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the first one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the second one" },
				expected: { label: "acknowledgement" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);
		expect(out).toContain(
			`review: ${join(forgeDirectory, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; only the first is offered — fix the file`,
		);
	});

	test("a cases file holding two entries under one id says so, naming the id and the file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the first one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the second one" },
				expected: { label: "acknowledgement" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);
		expect(out).toContain(
			`review: ${join(forgeDirectory, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; only the first is offered — fix the file`,
		);
	});
});

describe("review: a rename follows the pointers in its own file and no other", () => {
	test("a duplicate_of in another file that happens to spell the old id is left alone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
				duplicate_of: "polite-rejection-01",
			},
		]);
		// A hand-written pointer in another file spelling the same id. Case
		// ids are scenario-prefixed by convention, not by rule, so nothing
		// stops the two files from agreeing on a string — and a rename in
		// one file is not a rename in the other.
		await writeCases(forgeDirectory, "huge-signature", [
			{
				id: "huge-signature-01",
				scenario: "huge-signature",
				input: { email: "three" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
				duplicate_of: "polite-rejection-01",
			},
		]);

		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection-01",
			"id: polite-rejection-42",
		);
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		// Files are walked in sorted order, so huge-signature-01 is offered
		// first and approved; the rename lands on polite-rejection-01; the
		// drained queue skips the case that points at it. Both files are
		// written this pass, which is what lets a global map reach across.
		const { context } = await ctxIn(cwd, ["approve", "edit"]);
		try {
			expect(await run(["review", "--only", "cases"], context)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}

		const renamed = await readCases(forgeDirectory, "polite-rejection");
		expect(
			renamed.map((caseEntry) => [caseEntry.id, caseEntry.duplicate_of]),
		).toEqual([
			["polite-rejection-42", undefined],
			["polite-rejection-02", "polite-rejection-42"],
		]);
		const other = await readCases(forgeDirectory, "huge-signature");
		expect(
			other.map((caseEntry) => [
				caseEntry.id,
				caseEntry.duplicate_of,
				caseEntry.status,
			]),
		).toEqual([["huge-signature-01", "polite-rejection-01", "approved"]]);
	});
});

describe("review: a twin id across two files", () => {
	test("the rename lands in the file that received the decision, and the other file's pointer stays", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		// Both files hold an entry `aa-01` — a twin across files, which the
		// pass names — and both hold a pointer at it. `aa`'s entry is the
		// pending one, so it is the one offered and the one the rename
		// lands in. `bb` has a decision of its own, so it is written this
		// pass too: that is what let a map built from the pass's decisions
		// reach across.
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "aa", { status: "pending" }),
			CASE("aa-02", "aa", { duplicate_of: "aa-01" }),
		]);
		await writeCases(forgeDirectory, "bb", [
			CASE("aa-01", "bb"),
			CASE("bb-01", "bb", { duplicate_of: "aa-01", status: "pending" }),
		]);
		const editor = await editorReplacing(cwd, "id: aa-01", "id: aa-01-fixed");
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		// Offered in this order: aa-01 (pending, in aa), then bb-01, which
		// points at it and is placed right after it.
		const { context, out } = await ctxIn(cwd, ["edit", "approve"]);
		try {
			expect(await run(["review", "--only", "cases"], context)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
		expect(out[0]).toBe(
			`review: id "aa-01" is in ${join(forgeDirectory, "cases", "aa.yaml")} and ${join(forgeDirectory, "cases", "bb.yaml")}; each pass offers the first pending one — give them distinct ids`,
		);
		expect(
			(await readCases(forgeDirectory, "aa")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.duplicate_of,
			]),
		).toEqual([
			["aa-01-fixed", undefined],
			["aa-02", "aa-01-fixed"],
		]);
		expect(
			(await readCases(forgeDirectory, "bb")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.duplicate_of,
				caseEntry.status,
			]),
		).toEqual([
			["aa-01", undefined, "approved"],
			["bb-01", "aa-01", "approved"],
		]);
	});
});

describe("review: a twin id across two files, the other way round", () => {
	test("the reverse order: the pending twin is in the later file, and the decision lands there, not over the earlier file's approved case", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		// `aa`'s entry is approved; `bb`'s is the pending one offered. A
		// decision matched by id alone landed in `aa.yaml`, the first file
		// walked: bb's case, edited, was written over aa's approved case,
		// bb kept its pending copy, and the summary said 0 still pending.
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "aa", { input: { email: "aa-01 in aa" } }),
			CASE("aa-02", "aa", { duplicate_of: "aa-01" }),
		]);
		await writeCases(forgeDirectory, "bb", [
			CASE("aa-01", "bb", {
				input: { email: "aa-01 in bb" },
				status: "pending",
			}),
			CASE("bb-01", "bb", { duplicate_of: "aa-01" }),
		]);
		const aaFile = join(forgeDirectory, "cases", "aa.yaml");
		await utimes(aaFile, LONG_AGO, LONG_AGO);
		const editor = await editorReplacing(cwd, "id: aa-01", "id: aa-01-fixed");
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		const { context, out } = await ctxIn(cwd, ["edit"]);
		try {
			expect(await run(["review", "--only", "cases"], context)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
		expect((await stat(aaFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(
			(await readCases(forgeDirectory, "bb")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
				caseEntry.status,
				caseEntry.duplicate_of,
			]),
		).toEqual([
			["aa-01-fixed", "bb", "edited", undefined],
			["bb-01", "bb", "approved", "aa-01-fixed"],
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});
});

describe("review: a broken entry nobody is asked about does not block the pass", () => {
	test("an approved case naming another scenario lets --only feature review the feature, and 'nothing pending' stays exit 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		// Approved, so no pass offers it: a refusal here blocked the
		// feature's review over a case the person was never asked about.
		await writeCases(forgeDirectory, "aa", [CASE("aa-01", "bb")]);

		let { context, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "feature"], context)).toBe(0);
		expect((await readFeature(forgeDirectory)).status).toBe("approved");
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
		);

		({ context, out } = await ctxIn(cwd));
		expect(await run(["review"], context)).toBe(0);
		expect(out.at(-1)).toBe("review: nothing pending");
	});
});

describe("review --only: the count outside the filter is taken on disk too", () => {
	test("a twin id pending in two files counts as two", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "aa", { status: "pending" }),
		]);
		await writeCases(forgeDirectory, "bb", [
			CASE("aa-01", "bb", { status: "pending" }),
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "feature"], context)).toBe(0);
		expect(out.at(-1)).toBe(
			"review: nothing pending matching --only feature; 2 item(s) still pending outside that filter",
		);
	});
});

describe("review --all: an approved entry naming another scenario does not block the pass", () => {
	test("the pending case is approved and the approved entry is left as it was", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "bb"),
			CASE("aa-02", "aa", { status: "pending" }),
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--scenario", "aa", "--all"], context)).toBe(0);
		expect(out.at(-1)).toBe("review: approved 1 pending case(s) of aa");
		expect(
			(await readCases(forgeDirectory, "aa")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
				caseEntry.status,
			]),
		).toEqual([
			["aa-01", "bb", "approved"],
			["aa-02", "aa", "approved"],
		]);
	});
});

describe("review: a twin id across two files, both pending", () => {
	test("one is offered, and the summary still counts the other as pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "aa", { status: "pending" }),
		]);
		await writeCases(forgeDirectory, "bb", [
			CASE("aa-01", "bb", { status: "pending" }),
		]);
		const { context, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "cases"], context)).toBe(0);
		expect(
			(await readCases(forgeDirectory, "aa")).map(
				(caseEntry) => caseEntry.status,
			),
		).toEqual(["approved"]);
		expect(
			(await readCases(forgeDirectory, "bb")).map(
				(caseEntry) => caseEntry.status,
			),
		).toEqual(["pending"]);
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 1 still pending",
		);
	});
});

describe("review refuses a case that names another existing scenario before the first prompt", () => {
	test("exit 1 with the move that fixes it, and nothing written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "aa",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "bb",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		// A decision on this case would belong to `bb.yaml`, which does
		// not hold it: taken, it would land nowhere.
		await writeCases(forgeDirectory, "aa", [
			CASE("aa-01", "aa", { status: "pending" }),
			CASE("aa-02", "bb", { status: "pending" }),
		]);
		const aaFile = join(forgeDirectory, "cases", "aa.yaml");
		await utimes(aaFile, LONG_AGO, LONG_AGO);
		const { context, out } = await ctxIn(cwd, ["approve", "approve"]);
		expect(await run(["review", "--only", "cases"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: case aa-02 names scenario "bb" but lives in ${aaFile}; run \`llm-tests-forge move --case aa-02 --to bb\` or fix the file (file: ${aaFile}, id: aa-02)`,
		);
		expect(out.some((line) => line.startsWith("--- case"))).toBe(false);
		expect((await stat(aaFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("review refuses a second rename onto an id this pass already gave a sibling", () => {
	test("the first rename lands, the second is re-asked, and the pointer follows the one that landed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection", { status: "pending" }),
			CASE("polite-rejection-02", "polite-rejection", { status: "pending" }),
			CASE("polite-rejection-03", "polite-rejection", {
				duplicate_of: "polite-rejection-02",
			}),
		]);
		// The same editor renames whichever of the two it is handed to `bb-x`.
		const editor = join(cwd, "fake-editor-both.sh");
		await writeFile(
			editor,
			`#!/bin/sh\nsed 's|^id: polite-rejection-0[12]$|id: polite-rejection-x|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(editor, 0o755);
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
		// -01: edit → renamed to -x. -02: edit → refused (the id is taken
		// by the sibling this pass renamed), re-asked → skip.
		const { context, out } = await ctxIn(cwd, ["edit", "edit", "skip"]);
		try {
			expect(await run(["review", "--only", "cases"], context)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
		expect(out).toContain(
			'cannot apply: id "polite-rejection-x" is already used by another item in the same file; pick an id nothing else uses (id: polite-rejection-02)',
		);
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.status,
				caseEntry.duplicate_of,
			]),
		).toEqual([
			["polite-rejection-x", "edited", undefined],
			["polite-rejection-02", "pending", undefined],
			["polite-rejection-03", "approved", "polite-rejection-02"],
		]);
	});
});

describe("dedupe checks every scenario before it writes the first one", () => {
	test("an empty cases file later in the list is refused with the earlier file untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "zzz-empty",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		// One case is below the two `dedupeCases` needs to ask anything, so
		// this scenario reaches the write with nothing to change — which is
		// exactly the write that must not happen.
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);
		await writeCases(forgeDirectory, "zzz-empty", []);
		// `listCaseScenarios` sorts, so polite-rejection is reached first.
		const first = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(first, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["dedupe"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "zzz-empty" has no cases yet; run `llm-tests-forge cases --scenario zzz-empty` first (id: zzz-empty)',
		);
		expect((await stat(first)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(out.some((line) => line.includes("marked as duplicates"))).toBe(
			false,
		);
	});
});

describe("estimate", () => {
	test("prints one target row, one judge row, the total, the prices date and the notes; exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		const text = out.join("\n");
		expect(text).toMatch(
			/^estimate: 2 cases, 1 with a rubric; prices dated \d{4}-\d{2}-\d{2}$/m,
		);
		expect(text).toMatch(
			/^ {2}target {2}anthropic\/claude-haiku-4-5 .* 4 calls/m,
		);
		expect(text).toMatch(/^ {2}judge {3}google\/gemini-3\.5-flash.* 2 calls/m);
		expect(text).toContain("note: tokens are estimated as characters / 4");
		expect(text).toContain("note: application prompt not counted");
	});
	test("a single selected case with no rubric pluralizes to singular", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "solo",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "solo", [
			{
				id: "solo-01",
				scenario: "solo",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDirectory, SUITE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		expect(out[0]).toMatch(
			/^estimate: 1 case, 0 with a rubric; prices dated \d{4}-\d{2}-\d{2}$/m,
		);
	});
	test("counts the prompt file when feature.prompt_file is set, and drops the prompt note", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeFile(join(cwd, "prompt.txt"), "p".repeat(4000));
		await writeFeature(forgeDirectory, {
			...FEATURE,
			prompt_file: "prompt.txt",
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		const target = out.find((line) =>
			line.includes("anthropic/claude-haiku-4-5"),
		);
		// two cases × repeat 2 = 4 calls; each call is 1000 prompt tokens + ceil(20 / 4) input tokens → 4020 in
		expect(target).toMatch(/ {2}4 calls {4}40\d\d in/);
		expect(out.join("\n")).not.toContain("application prompt not counted");
	});
	test("a missing prompt_file is a ForgeError naming it (exit 1), not a silent zero", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeFeature(forgeDirectory, { ...FEATURE, prompt_file: "gone.txt" });
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(1);
		expect(out.at(-1)).toContain("gone.txt");
	});
	test("an absolute prompt_file is read from that path, not joined under the application root", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const outside = await mkdtemp(join(tmpdir(), "forge-prompt-"));
		const absolutePrompt = join(outside, "prompt.txt");
		await writeFile(absolutePrompt, "p".repeat(4000));
		await writeFeature(forgeDirectory, {
			...FEATURE,
			prompt_file: absolutePrompt,
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		const target = out.find((line) =>
			line.includes("anthropic/claude-haiku-4-5"),
		);
		// Same math as the relative-path case above: 4 calls, each 1000 prompt
		// tokens + ceil(20 / 4) input tokens -> 4020 in. An absolute
		// prompt_file that got joined under forgeDirectory/.. instead of resolved
		// would not exist there, and this would read as a missing-file error.
		expect(target).toMatch(/ {2}4 calls {4}40\d\d in/);
	});
	test("a prompt_file that is a directory names the real cause (exit 1), not 'file not found'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await mkdir(join(cwd, "prompt-dir"));
		await writeFeature(forgeDirectory, {
			...FEATURE,
			prompt_file: "prompt-dir",
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(1);
		expect(out.at(-1)).toContain("is a directory");
	});
	test("pending items are excluded and reported, not refused", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		expect(out).toContain(
			"estimate: 1 item excluded; run `llm-tests-forge review` to include it:",
		);
		expect(out).toContain(
			"  case polite-rejection-01 is pending (" +
				join(forgeDirectory, "cases", "polite-rejection.yaml") +
				")",
		);
	});
	test("more than one pending item pluralizes the exclusion message, listing both in scenario order", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
			// One case still selected, so the run has something to price:
			// zero selected cases is its own refusal, tested below.
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "z" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeCases(forgeDirectory, "vague-rubric", [
			{
				id: "vague-rubric-01",
				scenario: "vague-rubric",
				input: { email: "y" },
				expected: { rubric: "z" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		expect(out.slice(-3)).toEqual([
			"estimate: 2 items excluded; run `llm-tests-forge review` to include them:",
			`  case polite-rejection-01 is pending (${join(forgeDirectory, "cases", "polite-rejection.yaml")})`,
			`  case vague-rubric-01 is pending (${join(forgeDirectory, "cases", "vague-rubric.yaml")})`,
		]);
	});
	test("a rejected included scenario is excluded without telling the person to review it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "vague-rubric",
				kind: "ambiguous",
				oracle: "rubric",
				description: "d",
				status: "rejected",
			},
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection", "vague-rubric"],
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		expect(out.slice(-2)).toEqual([
			"estimate: 1 item excluded:",
			`  scenario vague-rubric is rejected (${join(forgeDirectory, "scenarios.yaml")})`,
		]);
		expect(out.join("\n")).not.toContain("llm-tests-forge review");
	});
	test("selecting no case at all exits 1 naming the cases directory, printing no table", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDirectory, SUITE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(1);
		expect(out.at(-1)).toContain("no approved case to estimate");
		expect(out.at(-1)).toContain(join(forgeDirectory, "cases"));
		expect(out.join("\n")).not.toContain("prices dated");
	});
	test("a missing suite.yaml exits 1 with the example to copy", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(1);
		expect(out.join("\n")).toContain("suite.yaml not found");
		expect(out.join("\n")).toContain("judges:");
	});
	test("an unknown flag is a usage error (exit 2)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { context } = await ctxIn(cwd);
		expect(await run(["estimate", "--bogus"], context)).toBe(2);
	});
});

describe("emit", () => {
	test("writes promptfooconfig.yaml and the shim, prints what it wrote, exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		const parsedConfig = parse(
			await readFile(join(forgeDirectory, "promptfooconfig.yaml"), "utf8"),
		);
		expect(
			parsedConfig.tests.map(
				(testEntry: { description: string }) => testEntry.description,
			),
		).toEqual(["polite-rejection-01", "vague-rubric-01"]);
		expect(parsedConfig.providers[0].id).toBe("file://forge_target.py");
		expect(
			await readFile(join(forgeDirectory, "forge_target.py"), "utf8"),
		).toContain('INPUTS = ["email"]');
		expect(out).toContain(
			`emit: wrote ${join(forgeDirectory, "promptfooconfig.yaml")} (2 cases, 2 scenarios, 1 target model, 1 judge)`,
		);
		expect(out).toContain(
			`emit: wrote ${join(forgeDirectory, "forge_target.py")}; edit run_application() to call your application`,
		);
	});
	test("a single case, scenario, target model and judge pluralizes to singular", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "solo",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "solo", [
			{
				id: "solo-01",
				scenario: "solo",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDirectory, SUITE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out).toContain(
			`emit: wrote ${join(forgeDirectory, "promptfooconfig.yaml")} (1 case, 1 scenario, 1 target model, 1 judge)`,
		);
	});
	test("never overwrites an existing shim, and says it kept it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const shim = join(forgeDirectory, "forge_target.py");
		await writeFile(shim, "# mine\n");
		await utimes(shim, LONG_AGO, LONG_AGO);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(await readFile(shim, "utf8")).toBe("# mine\n");
		expect((await stat(shim)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(out).toContain(`emit: kept existing ${shim}`);
	});
	test("refuses on pending items, lists every one, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "y" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain(
			"error: emit refused: 2 items block it; run `llm-tests-forge review`",
		);
		expect(text).toContain("case polite-rejection-01 is pending");
		expect(text).toContain("case polite-rejection-02 is pending");
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(
			stat(join(forgeDirectory, "forge_target.py")),
		).rejects.toThrow();
	});
	test("a rejected included scenario blocks emit without telling the person to review it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "rejected",
			},
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection"],
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain("error: emit refused: 1 item blocks it");
		expect(text).toContain("scenario polite-rejection is rejected");
		expect(text).not.toContain("llm-tests-forge review");
	});
	test("a case whose expected no longer matches its scenario's oracle blocks emit, naming both", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		// The oracle was edited to `fields` after the case was approved
		// against `label`; the expected on disk is now the wrong shape.
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "fields",
				description: "d",
				status: "edited",
			},
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection"],
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain(
			"error: emit refused: 1 item blocks it; run `llm-tests-forge review`",
		);
		expect(text).toContain(
			`case polite-rejection-01: oracle is fields but expected.fields is missing (${join(forgeDirectory, "cases", "polite-rejection.yaml")})`,
		);
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(
			stat(join(forgeDirectory, "forge_target.py")),
		).rejects.toThrow();
	});
	test("a target.entry that is a path, not a file name, is refused before anything is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { ...SUITE.target, entry: "../escaped.py" },
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out.at(-1)).toContain(
			"target.entry must be a file name inside .forge, not a path",
		);
		expect(out.at(-1)).toContain(join(forgeDirectory, "suite.yaml"));
		await expect(stat(join(cwd, "escaped.py"))).rejects.toThrow();
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
	});
	test("--format jsonl writes cases.jsonl and no shim", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "jsonl"], context)).toBe(0);
		const lines = (await readFile(join(forgeDirectory, "cases.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => line.id)).toEqual([
			"polite-rejection-01",
			"vague-rubric-01",
		]);
		await expect(
			stat(join(forgeDirectory, "forge_target.py")),
		).rejects.toThrow();
		expect(out).toContain(
			`emit: wrote ${join(forgeDirectory, "cases.jsonl")} (2 cases)`,
		);
	});
	test("an unknown --format is a usage error naming the valid values", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "xml"], context)).toBe(2);
		expect(out.at(-1)).toContain("promptfoo, jsonl");
	});
	test("a pending feature is refused before anything is read (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out.at(-1)).toContain("pending");
	});
	test("--format jsonl with zero approved cases and no blockers refuses, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDirectory, SUITE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "jsonl"], context)).toBe(1);
		expect(out.at(-1)).toContain("no approved case");
		expect(out.at(-1)).toContain(join(forgeDirectory, "cases"));
		await expect(stat(join(forgeDirectory, "cases.jsonl"))).rejects.toThrow();
	});
	test("--format promptfoo (default) with zero approved cases and no blockers refuses, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDirectory, SUITE);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out.at(-1)).toContain("no approved case");
		expect(out.at(-1)).toContain(join(forgeDirectory, "cases"));
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(
			stat(join(forgeDirectory, "forge_target.py")),
		).rejects.toThrow();
	});
});

describe("report", () => {
	const RESULTS = resolve("tests/fixtures/promptfoo-results-0.123.0.json");

	async function forgeMatchingFixture(cwd: string) {
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "ack-optional-quiz",
				kind: "ambiguous",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "out-of-scope-newsletter",
				kind: "out_of_scope",
				oracle: "rubric",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "ack-optional-quiz", [
			{
				id: "ack-optional-quiz-01",
				scenario: "ack-optional-quiz",
				input: { email: "x" },
				expected: { label: "acknowledgement" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeCases(forgeDirectory, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-02",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { ...SUITE.target, models: ["target-haiku-4-5"] },
		});
		return forgeDirectory;
	}

	test("writes report.md and report.json from the real fixture and prints the headline; exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		expect(json.matched).toBe(4);
		expect(json.passRate).toBe(1);
		expect(
			json.cases.map((caseEntry: { case: string }) => caseEntry.case),
		).toEqual(["ack-optional-quiz-01", "out-of-scope-newsletter-02"]);
		expect(json.promptfooVersion).toBe("0.123.0");
		const markdown = await readFile(join(forgeDirectory, "report.md"), "utf8");
		expect(markdown).toContain(
			"**Pass rate:** 100.0% (4 of 4 runs, 0 errored)",
		);
		expect(markdown).toContain("No failing or errored case.");
		expect(out).toContain(
			"report: 4 of 4 rows matched; pass rate 100.0%; 0 failing or errored; 0 flaky; 0 judge disagreements",
		);
		expect(out).toContain(
			`report: wrote ${join(forgeDirectory, "report.md")} and ${join(forgeDirectory, "report.json")}`,
		);
	});

	test("a scenario the suite's include leaves out is named under not in this suite", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		// `include` narrows the suite to one of the two fixture scenarios;
		// the other still has a reviewed case on disk, so the coverage
		// sentence must name it apart from a scenario that ran and matched
		// nothing.
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { ...SUITE.target, models: ["target-haiku-4-5"] },
			include: ["ack-optional-quiz"],
		});
		const { context } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		expect(json.coverage.notSelected).toEqual(["out-of-scope-newsletter"]);
		expect(json.coverage.withoutRun).toEqual([]);
		const markdown = await readFile(join(forgeDirectory, "report.md"), "utf8");
		expect(markdown).toContain(
			"Coverage: 1 of 2 reviewed scenarios ran; not in this suite: out-of-scope-newsletter",
		);
	});

	test("compares the run against the estimate the person saw before running", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const { context } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		const judge = json.costs.find(
			(caseEntry: { role: string }) => caseEntry.role === "judge",
		) as { model: string; estimatedDollars: number };
		expect(judge.model).toBe("google/gemini-3.5-flash");
		// Computed from the real prices.yaml row for google/gemini-3.5-flash
		// (input 1.5, output 9 per million tokens) and the one rubric case
		// forgeMatchingFixture selects (out-of-scope-newsletter-02, whose
		// rubric text is the single character "r", 1 token): perJudgeCalls
		// is 1 target model * repeat 2 = 2; input tokens per call are the
		// label output guess (8) + the rubric (1) + JUDGE_PROMPT_OVERHEAD
		// (200) = 209, so 418 total; output tokens are 2 calls *
		// JUDGE_OUTPUT_TOKENS (174) = 348. The suite's one non-rubric case's
		// label ("acknowledgement", approxTokens 4) is below the label guess
		// (8), so the guess wins.
		expect(judge.estimatedDollars).toBe((418 * 1.5 + 348 * 9) / 1_000_000);
	});

	test("--baseline reads a previous report.json and reports what changed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.context)).toBe(0);
		const previous = join(cwd, "previous.json");
		const baseline = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		// pretend the first case was failing before
		baseline.cases[0].stability = "failing";
		await writeFile(previous, JSON.stringify(baseline));
		const second = await ctxIn(cwd);
		expect(
			await run(["report", RESULTS, "--baseline", previous], second.context),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 1 fixed",
		);
		const markdown = await readFile(join(forgeDirectory, "report.md"), "utf8");
		expect(markdown).toContain("Fixed since baseline: 1.");
	});

	test("rows of a case the suite no longer selects are listed apart, not counted into the pass rate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		// The case is still on disk and still has rows in results.json, but
		// the estimate priced the run without it.
		await writeCases(forgeDirectory, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-02",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "rejected",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		expect(json.matched).toBe(2);
		expect(json.unmatched).toEqual([
			"row 2 (testIdx 2): target-haiku-4-5: out-of-scope-newsletter-02 (not in the current selection)",
			"row 3 (testIdx 3): target-haiku-4-5: out-of-scope-newsletter-02 (not in the current selection)",
		]);
		expect(
			json.cases.map((caseEntry: { case: string }) => caseEntry.case),
		).toEqual(["ack-optional-quiz-01"]);
		expect(out).toContain(
			"report: 2 of 4 rows matched; pass rate 100.0%; 0 failing or errored; 0 flaky; 0 judge disagreements",
		);
	});

	test("a results file whose rows match no case exits 1 and names the file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		await writeCases(forgeDirectory, "ack-optional-quiz", [
			{
				id: "ack-optional-quiz-09",
				scenario: "ack-optional-quiz",
				input: { email: "x" },
				expected: { label: "acknowledgement" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeCases(forgeDirectory, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-09",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "approved",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(1);
		expect(out.at(-1)).toContain(RESULTS);
		expect(out.at(-1)).toContain("forge emitted");
		expect(out.at(-1)).toContain(
			'first metadata.case seen: "ack-optional-quiz-01", 4 rows',
		);
		await expect(stat(join(forgeDirectory, "report.md"))).rejects.toThrow();
	});

	test("no positional argument is a usage error (exit 2) naming results.json", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report"], context)).toBe(2);
		expect(out.at(-1)).toContain("results.json");
	});

	test("a baseline that is not a report is a ForgeError naming the file (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const bad = join(cwd, "bad.json");
		await writeFile(bad, "{}");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", bad], context)).toBe(1);
		expect(out.at(-1)).toContain(bad);
		expect(out.at(-1)).toContain("is not a report written by llm-tests-forge");
	});

	test("a baseline that is not JSON at all names the file and the problem", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const bad = join(cwd, "bad.json");
		await writeFile(bad, "{not json");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", bad], context)).toBe(1);
		expect(out.at(-1)).toContain("invalid JSON");
		expect(out.at(-1)).toContain(bad);
	});

	test("a baseline file that does not exist names it (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const missing = join(cwd, "gone.json");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", missing], context)).toBe(
			1,
		);
		expect(out.at(-1)).toContain(missing);
		expect(out.at(-1)).toContain("baseline not found");
	});

	test("an empty --baseline is reported, not silently ignored", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", ""], context)).toBe(1);
		expect(out.at(-1)).toContain("baseline not found");
	});

	test("a pending feature is refused before anything is read (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], context)).toBe(1);
		expect(out.at(-1)).toContain("pending");
	});

	test("a baseline in the shape the previous version wrote is still accepted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.context)).toBe(0);
		const previous = join(cwd, "previous.json");
		const baseline = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		// The shape a report.json carried before this branch, read off
		// e980d07's examples/moonlighter-classify-email/.forge/report.json:
		// `coverage.approvedScenarios` rather than `reviewedScenarios`, and
		// no `failing` at all. Both changed here, and a baseline is by
		// definition a file an older binary wrote.
		baseline.coverage = {
			approvedScenarios: baseline.coverage.reviewedScenarios,
			withRuns: baseline.coverage.withRuns,
			withoutCase: baseline.coverage.withoutCase,
		};
		delete baseline.failing;
		// Something to diff against, so the run proves the old file was read
		// rather than merely accepted: pretend the first case failed then.
		baseline.cases[0].stability = "failing";
		await writeFile(previous, JSON.stringify(baseline));
		const second = await ctxIn(cwd);
		expect(
			await run(["report", RESULTS, "--baseline", previous], second.context),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 1 fixed",
		);
	});

	test("after llm-tests-forge move renames a scenario, the baseline diff names the pairs it could not compare and coverage names the scenario", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.context)).toBe(0);
		const previous = join(cwd, "previous.json");
		await writeFile(
			previous,
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);

		const moved = await ctxIn(cwd);
		expect(
			await run(
				["move", "--scenario", "ack-optional-quiz", "ack-quiz"],
				moved.context,
			),
		).toBe(0);

		// The results file still names `ack-optional-quiz-01`: that row is
		// unmatched, the renamed scenario ran nothing, and the baseline's
		// pair for it has no counterpart.
		const second = await ctxIn(cwd);
		expect(
			await run(["report", RESULTS, "--baseline", previous], second.context),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 0 fixed, 1 baseline pair(s) not in this run",
		);
		const json = JSON.parse(
			await readFile(join(forgeDirectory, "report.json"), "utf8"),
		);
		expect(json.baseline.onlyInBaseline).toEqual([
			{ case: "ack-optional-quiz-01", model: "target-haiku-4-5" },
		]);
		expect(json.coverage.withoutRun).toEqual(["ack-quiz"]);
		const markdown = await readFile(join(forgeDirectory, "report.md"), "utf8");
		expect(markdown).toContain(
			"Coverage: 1 of 2 reviewed scenarios ran; no matched run: ack-quiz",
		);
		expect(markdown).toContain(
			"Not in this run, so not compared: 1 baseline pair(s) — ack-optional-quiz-01 @ target-haiku-4-5.",
		);
	});

	test("report.json is readable back as its own baseline", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.context)).toBe(0);
		const second = await ctxIn(cwd);
		expect(
			await run(
				["report", RESULTS, "--baseline", join(forgeDirectory, "report.json")],
				second.context,
			),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 0 fixed",
		);
	});
});

/** `null` when the path is not there; a real `stat` otherwise. */
const statOrNull = (path: string) => stat(path).catch(() => null);

const CASE = (
	id: string,
	scenario: string,
	extra: Partial<Parameters<typeof writeCases>[2][number]> = {},
) => ({
	id,
	scenario,
	input: { email: id },
	expected: { label: "rejection" },
	status: "approved" as const,
	generated_by: "hand",
	...extra,
});

describe("llm-tests-forge move --scenario <old> <new>", () => {
	test("renames the scenario, renumbers its cases into the new file, deletes the old file, and follows suite.include", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "polite-rejection", {
				duplicate_of: "polite-rejection-01",
				status: "pending",
			}),
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection"],
		});

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario polite-rejection → soft-no; 2 case(s) renumbered",
			"move: suite.include updated",
		]);

		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => [
				scenario.id,
				scenario.status,
			]),
		).toEqual([["soft-no", "approved"]]);
		const moved = await readCases(forgeDirectory, "soft-no");
		expect(
			moved.map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
				caseEntry.status,
				caseEntry.duplicate_of,
			]),
		).toEqual([
			["soft-no-01", "soft-no", "approved", undefined],
			["soft-no-02", "soft-no", "pending", "soft-no-01"],
		]);
		expect(
			await statOrNull(join(forgeDirectory, "cases", "polite-rejection.yaml")),
		).toBeNull();
		expect((await readSuite(forgeDirectory)).include).toEqual(["soft-no"]);
	});

	test("a suite that does not name the scenario is not rewritten, and a scenario with no cases file gets none", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeSuite(forgeDirectory, SUITE);
		const suiteFile = join(forgeDirectory, "suite.yaml");
		await utimes(suiteFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario polite-rejection → soft-no; 0 case(s) renumbered",
		]);
		expect((await stat(suiteFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
		// No cases file existed, so none is invented: an empty
		// `cases/soft-no.yaml` would read to every later verb as a scenario
		// that already has cases.
		expect(
			await statOrNull(join(forgeDirectory, "cases", "soft-no.yaml")),
		).toBeNull();
		expect((await readScenarios(forgeDirectory))[0]?.id).toBe("soft-no");
	});

	test("without a suite.yaml nothing is invented", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		const { context } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(await statOrNull(join(forgeDirectory, "suite.yaml"))).toBeNull();
	});

	test("an unknown old id and a taken new id are refused by name, and nothing is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		await utimes(scenariosFile, LONG_AGO, LONG_AGO);

		let { context, out } = await ctxIn(cwd);
		expect(await run(["move", "--scenario", "ghost", "soft-no"], context)).toBe(
			1,
		);
		expect(out.at(-1)).toBe(
			'error: scenario "ghost" is not in scenarios.yaml (id: ghost)',
		);

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["move", "--scenario", "polite-rejection", "polite-rejection"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "polite-rejection" already exists in scenarios.yaml; pick an id nothing else uses (id: polite-rejection)',
		);
		expect((await stat(scenariosFile)).mtime.getTime()).toBe(
			LONG_AGO.getTime(),
		);
	});

	test("a new id that is not a bare file name is a usage error", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedScenario(cwd);
		for (const bad of ["../soft-no", "soft/no", "soft-no.yaml", ".soft"]) {
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(["move", "--scenario", "polite-rejection", bad], context),
			).toBe(2);
			expect(out.at(-1)).toBe(
				`error: "${bad}" cannot name a scenario: it becomes .forge/cases/<id>.yaml, so it takes letters, digits, "-", "_" and "." only, starts with a letter or digit, and does not end in ".yaml"`,
			);
		}
	});

	test("the new cases file is written before the old one is removed: a write that fails leaves everything as it was", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const oldFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		await utimes(oldFile, LONG_AGO, LONG_AGO);
		await utimes(scenariosFile, LONG_AGO, LONG_AGO);
		// A bare id the filesystem refuses as a file name: the write of
		// `cases/<new>.yaml` fails, and nothing after it may have happened.
		const tooLong = "x".repeat(300);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", tooLong], context),
		).toBe(1);
		expect(out.at(-1)).toStartWith(
			`error: cannot write: ENAMETOOLONG: name too long, open '${join(forgeDirectory, "cases", `${tooLong}.yaml`)}'`,
		);
		expect((await stat(oldFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect((await stat(scenariosFile)).mtime.getTime()).toBe(
			LONG_AGO.getTime(),
		);
	});

	test("a new id whose cases file already exists on disk is refused before anything is written, and that file is untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		// A stray file with no scenarios.yaml entry: nothing but the disk
		// knows it is there, and it holds a case someone wrote by hand.
		const stray = join(forgeDirectory, "cases", "soft-no.yaml");
		await writeCases(forgeDirectory, "soft-no", [
			CASE("hand-written", "soft-no", { input: { email: "PRECIOUS" } }),
		]);
		const oldFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		for (const fileName of [stray, oldFile, scenariosFile])
			await utimes(fileName, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: cases/soft-no.yaml already exists; pick another id or move that file away first (file: ${stray}, id: soft-no)`,
		);
		for (const fileName of [stray, oldFile, scenariosFile])
			expect((await stat(fileName)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(await readFile(stray, "utf8")).toContain("PRECIOUS");
	});

	test("a new id that differs from the old file's name only by case is refused on every filesystem", async () => {
		// On the default macOS filesystem `Polite-Rejection.yaml` is the
		// same file as `polite-rejection.yaml`: the rename wrote the new
		// file onto the old one and then deleted it, three cases gone.
		// Refused by name so the outcome does not depend on the disk.
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const oldFile = join(forgeDirectory, "cases", "polite-rejection.yaml");

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--scenario", "polite-rejection", "Polite-Rejection"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: "Polite-Rejection" differs from "polite-rejection" only in letter case or Unicode normalisation, which is one file on the default macOS filesystem; rename through a temporary id: llm-tests-forge move --scenario polite-rejection tmp-Polite-Rejection && llm-tests-forge move --scenario tmp-Polite-Rejection Polite-Rejection (file: ${oldFile}, id: Polite-Rejection)`,
		);
		// The advice, followed: two renames, three files never in
		// conflict, and the cases renumbered at the end.
		for (const [sourceId, destinationId] of [
			["polite-rejection", "tmp-Polite-Rejection"],
			["tmp-Polite-Rejection", "Polite-Rejection"],
		]) {
			const step = await ctxIn(cwd);
			expect(
				await run(
					["move", "--scenario", sourceId ?? "", destinationId ?? ""],
					step.context,
				),
			).toBe(0);
		}
		expect(
			(await readCases(forgeDirectory, "Polite-Rejection")).map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
			]),
		).toEqual([["Polite-Rejection-01", "Polite-Rejection"]]);
		expect((await readScenarios(forgeDirectory))[0]?.id).toBe(
			"Polite-Rejection",
		);
	});

	test("a case-only rename of a scenario without a cases file is an ordinary rename", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--scenario", "polite-rejection", "Polite-Rejection"],
				context,
			),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario polite-rejection → Polite-Rejection; 0 case(s) renumbered",
		]);
		expect((await readScenarios(forgeDirectory))[0]?.id).toBe(
			"Polite-Rejection",
		);
	});

	test("suite.yaml keeps its comments and layout: only the include entry changes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		const suiteFile = join(forgeDirectory, "suite.yaml");
		const handWritten = `target:
  kind: promptfoo-python
  entry: forge_target.py
  python: .venv/bin/python  # any interpreter that can import the app
  models: [anthropic/claude-haiku-4-5]
judges: [google/gemini-3.5-flash]
repeat: 2
include: [keep, polite-rejection, keep]   # only these for now
`;
		await writeFile(suiteFile, handWritten);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(out.at(-1)).toBe("move: suite.include updated");
		// `writeSuite` would have dropped both comments and turned the flow
		// lists into blocks. The Document printer keeps them and only
		// normalises spacing, so the pin is on the lines, not on the bytes.
		const after = await readFile(suiteFile, "utf8");
		expect(after.split("\n")).toEqual([
			"target:",
			"  kind: promptfoo-python",
			"  entry: forge_target.py",
			"  python: .venv/bin/python # any interpreter that can import the app",
			"  models: [anthropic/claude-haiku-4-5]",
			"judges: [google/gemini-3.5-flash]",
			"repeat: 2",
			"include: [keep, soft-no, keep] # only these for now",
			"",
		]);
		expect((await readSuite(forgeDirectory)).include).toEqual([
			"keep",
			"soft-no",
			"keep",
		]);
	});
});

describe("llm-tests-forge move --scenario: the source file and the suite", () => {
	test("a source file spelled with different case than the id is refused, and scenarios.yaml is untouched", async () => {
		// The read resolves case-insensitively on macOS, so the cases were
		// read and renamed in memory, the file was neither written nor
		// removed, and scenarios.yaml was renamed around it: "3 case(s)
		// renumbered", exit 0, and every later verb dropped the three.
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "Polite-Rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const file = join(forgeDirectory, "cases", "Polite-Rejection.yaml");
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		await utimes(scenariosFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "polite-rejection" has a cases file spelled "Polite-Rejection" (letter case or Unicode normalisation differs); rename one so they match (file: ${file}, id: polite-rejection)`,
		);
		expect((await stat(scenariosFile)).mtime.getTime()).toBe(
			LONG_AGO.getTime(),
		);
		expect(
			await statOrNull(join(forgeDirectory, "cases", "soft-no.yaml")),
		).toBeNull();
	});

	test("a file holding no case is not carried forward: it is removed and the line says so", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", []);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario polite-rejection → soft-no; 0 case(s) renumbered",
			"move: cases/polite-rejection.yaml held no case and was removed",
		]);
		expect(
			await statOrNull(join(forgeDirectory, "cases", "polite-rejection.yaml")),
		).toBeNull();
		expect(
			await statOrNull(join(forgeDirectory, "cases", "soft-no.yaml")),
		).toBeNull();
	});

	test("renaming the imported scenario says that later imports will not land in it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "imported",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "imported", [
			CASE("imported-01", "imported"),
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "imported", "real-inputs"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario imported → real-inputs; 1 case(s) renumbered",
			'move: later imports start a new "imported" scenario; real-inputs keeps these cases',
		]);
	});

	test("an include entry reached through a YAML alias cannot be rewritten in place: refused before any write", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const suiteFile = join(forgeDirectory, "suite.yaml");
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		const oldFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const head = `target:
  kind: promptfoo-python
  entry: forge_target.py
  models: [anthropic/claude-haiku-4-5]
judges: [google/gemini-3.5-flash]
`;
		// Two shapes: the whole list through an alias, and one item.
		for (const tail of [
			"shared: &inc [polite-rejection]\ninclude: *inc\n",
			"first: &one polite-rejection\ninclude: [*one, keep]\n",
		]) {
			await writeFile(suiteFile, head + tail);
			for (const fileName of [suiteFile, scenariosFile, oldFile])
				await utimes(fileName, LONG_AGO, LONG_AGO);
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--scenario", "polite-rejection", "soft-no"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: suite.include names "polite-rejection" 1 time(s) but only 0 can be rewritten in place: the rest come through a YAML alias; edit suite.yaml by hand (file: ${suiteFile}, id: polite-rejection)`,
			);
			for (const fileName of [suiteFile, scenariosFile, oldFile])
				expect((await stat(fileName)).mtime.getTime()).toBe(LONG_AGO.getTime());
		}
	});

	test("a flow list longer than the printer's default width stays on one line", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		const suiteFile = join(forgeDirectory, "suite.yaml");
		const models =
			"[anthropic/claude-haiku-4-5, anthropic/claude-sonnet-5, google/gemini-3.5-flash, openai/gpt-5-mini, ollama/llama4]";
		await writeFile(
			suiteFile,
			`target:\n  kind: promptfoo-python\n  entry: forge_target.py\n  models: ${models}\njudges: [google/gemini-3.5-flash]\ninclude: [polite-rejection]\n`,
		);

		const { context } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(await readFile(suiteFile, "utf8")).toContain(
			`  models: ${models}\n`,
		);
	});
});

describe("llm-tests-forge move --case <id> --to <scenario>", () => {
	async function twoScenarios(
		cwd: string,
		destinationOracle: "label" | "rubric" = "label",
	) {
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "huge-signature",
				kind: "edge",
				oracle: destinationOracle,
				description: "d",
				status: "approved",
			},
		]);
		return forgeDirectory;
	}

	test("moves the case into the destination's numbering, drops the duplicate pointers, and rewrites the destination before the source", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await twoScenarios(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "polite-rejection", {
				duplicate_of: "polite-rejection-01",
			}),
			CASE("polite-rejection-03", "polite-rejection", {
				duplicate_of: "polite-rejection-02",
			}),
		]);
		await writeCases(forgeDirectory, "huge-signature", [
			CASE("huge-signature-01", "huge-signature"),
			CASE("huge-signature-02", "huge-signature"),
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-02", "--to", "huge-signature"],
				context,
			),
		).toBe(0);
		expect(out).toEqual([
			"move: polite-rejection-02 → huge-signature-03 (scenario huge-signature)",
		]);
		const destination = await readCases(forgeDirectory, "huge-signature");
		expect(
			destination.map((caseEntry) => [
				caseEntry.id,
				caseEntry.scenario,
				caseEntry.status,
			]),
		).toEqual([
			["huge-signature-01", "huge-signature", "approved"],
			["huge-signature-02", "huge-signature", "approved"],
			["huge-signature-03", "huge-signature", "approved"],
		]);
		expect(destination[2]).not.toHaveProperty("duplicate_of");
		expect(destination[2]?.input).toEqual({ email: "polite-rejection-02" });
		const source = await readCases(forgeDirectory, "polite-rejection");
		expect(source.map((caseEntry) => caseEntry.id)).toEqual([
			"polite-rejection-01",
			"polite-rejection-03",
		]);
		expect(source[1]).not.toHaveProperty("duplicate_of");
	});

	test("a case whose expected the destination's oracle does not accept is re-opened, and the line says why", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await twoScenarios(cwd, "rubric");
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
				context,
			),
		).toBe(0);
		expect(out.slice(0, 2)).toEqual([
			"move: polite-rejection-01 → huge-signature-01 (scenario huge-signature)",
			"move: huge-signature-01 re-opened: oracle is rubric but expected.rubric is missing — edit it in `llm-tests-forge review` to give it an expected the rubric oracle accepts",
		]);
		const destination = await readCases(forgeDirectory, "huge-signature");
		expect(
			destination.map((caseEntry) => [caseEntry.id, caseEntry.status]),
		).toEqual([["huge-signature-01", "pending"]]);
		expect(destination[0]?.expected).toEqual({ label: "rejection" });
		expect(out[2]).toBe(
			"move: cases/polite-rejection.yaml removed; it held no other case",
		);
		// The last case took the file with it: a `[]` left behind read to
		// `dedupe` as a scenario to refuse, run after run.
		expect(
			await statOrNull(join(forgeDirectory, "cases", "polite-rejection.yaml")),
		).toBeNull();
		const after = await ctxIn(cwd);
		expect(await run(["dedupe"], after.context)).toBe(0);
		expect(after.out).toEqual([
			"dedupe: huge-signature: 0 marked as duplicates",
		]);
	});

	test("the case is found by scanning every cases file, so a hand-edited file holding it is the source", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await twoScenarios(cwd);
		// The situation `review --all` refuses: a case in polite-rejection's
		// file whose `scenario` already says huge-signature.
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "huge-signature"),
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-02", "--to", "huge-signature"],
				context,
			),
		).toBe(0);
		expect(out).toEqual([
			"move: polite-rejection-02 → huge-signature-01 (scenario huge-signature)",
		]);
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["polite-rejection-01"]);
		expect(
			(await readCases(forgeDirectory, "huge-signature")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["huge-signature-01"]);
	});

	test("refuses an unknown case, a case held by two files, an unknown scenario, the scenario it is already in, and a pending feature", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await twoScenarios(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const casesDirectory = join(forgeDirectory, "cases");

		let { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "ghost-01", "--to", "huge-signature"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: case "ghost-01" is not in any cases file (file: ${casesDirectory}, id: ghost-01)`,
		);

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "ghost"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe('error: scenario "ghost" not found (id: ghost)');

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "polite-rejection"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: case "polite-rejection-01" is already in scenario "polite-rejection" (id: polite-rejection-01)',
		);

		await writeCases(forgeDirectory, "huge-signature", [
			CASE("polite-rejection-01", "huge-signature"),
		]);
		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: case "polite-rejection-01" is in 2 cases files (huge-signature, polite-rejection); fix the files so it is in one (file: ${casesDirectory}, id: polite-rejection-01)`,
		);

		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		({ context, out } = await ctxIn(cwd));
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toContain("feature is pending");
	});

	test("the destination is written before the source: a write that fails leaves the source as it was", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const tooLong = "x".repeat(300);
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: tooLong,
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const sourceFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(sourceFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", tooLong],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toStartWith(
			`error: cannot write: ENAMETOOLONG: name too long, open '${join(forgeDirectory, "cases", `${tooLong}.yaml`)}'`,
		);
		expect((await stat(sourceFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("llm-tests-forge move --case: the destination's file and status", () => {
	test("a destination whose cases file is spelled with different case is refused, so the file is never replaced", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "Huge-Signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		// The file was named by hand in lower case; scenarios.yaml says
		// otherwise. Looked up by the id it is missed, and on a
		// case-insensitive disk the write then lands on this very file.
		await writeCases(forgeDirectory, "huge-signature", [
			CASE("huge-signature-01", "Huge-Signature", {
				input: { email: "PRECIOUS" },
			}),
		]);
		const file = join(forgeDirectory, "cases", "huge-signature.yaml");
		await utimes(file, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "Huge-Signature"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "Huge-Signature" has a cases file spelled "huge-signature" (letter case or Unicode normalisation differs); rename one so they match (file: ${file}, id: Huge-Signature)`,
		);
		expect((await stat(file)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(
			(await readCases(forgeDirectory, "polite-rejection")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["polite-rejection-01"]);
	});

	test("a case moved into a scenario that is not approved says it will not run", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "rejected",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "polite-rejection"),
		]);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-02", "--to", "huge-signature"],
				context,
			),
		).toBe(0);
		expect(out).toEqual([
			"move: polite-rejection-02 → huge-signature-01 (scenario huge-signature)",
			"move: scenario huge-signature is rejected, so huge-signature-01 will not run until the scenario is approved",
		]);
		expect(
			(await readCases(forgeDirectory, "huge-signature")).map(
				(caseEntry) => caseEntry.status,
			),
		).toEqual(["approved"]);
	});
});

describe("llm-tests-forge move --case: a twin id in the source", () => {
	test("exits 1 naming the file, moves nothing, and drops nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection", {
				input: { email: "FIRST" },
			}),
			CASE("polite-rejection-01", "polite-rejection", {
				input: { email: "SECOND" },
			}),
			CASE("polite-rejection-02", "polite-rejection"),
		]);
		const sourceFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(sourceFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: cases file of scenario "polite-rejection" holds 2 entries under id "polite-rejection-01"; fix the file first (id: polite-rejection-01)',
		);
		expect((await stat(sourceFile)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(
			await statOrNull(join(forgeDirectory, "cases", "huge-signature.yaml")),
		).toBeNull();
		expect(await readFile(sourceFile, "utf8")).toContain("SECOND");
	});
});

describe("llm-tests-forge move: a file name that differs from the id only in Unicode normalisation", () => {
	// `café` written to disk as NFC, named in scenarios.yaml as NFD: APFS
	// opens the file by either spelling, JavaScript compares them unequal,
	// and the case-only guard let both forms through.
	const nfc = "caf\u00e9";
	const nfd = "cafe\u0301";

	test("--scenario refuses the source, and scenarios.yaml is untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: nfd,
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, nfc, [CASE(`${nfd}-01`, nfd)]);
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		await utimes(scenariosFile, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["move", "--scenario", nfd, "soft-no"], context)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "${nfd}" has a cases file spelled "${nfc}" (letter case or Unicode normalisation differs); rename one so they match (file: ${join(forgeDirectory, "cases", `${nfc}.yaml`)}, id: ${nfd})`,
		);
		expect((await stat(scenariosFile)).mtime.getTime()).toBe(
			LONG_AGO.getTime(),
		);
	});

	test("--case refuses the destination, and its file is untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: nfd,
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		await writeCases(forgeDirectory, nfc, [
			CASE(`${nfd}-01`, nfd, { input: { email: "PRECIOUS" } }),
		]);
		const file = join(forgeDirectory, "cases", `${nfc}.yaml`);
		await utimes(file, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", nfd],
				context,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "${nfd}" has a cases file spelled "${nfc}" (letter case or Unicode normalisation differs); rename one so they match (file: ${file}, id: ${nfd})`,
		);
		expect((await stat(file)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("llm-tests-forge move --scenario: a write that fails after the first one", () => {
	test("names what is already on disk and what to do by hand", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		const scenariosFile = join(forgeDirectory, "scenarios.yaml");
		await chmod(scenariosFile, 0o444);
		try {
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--scenario", "polite-rejection", "soft-no"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: cannot write: EACCES: permission denied, open '${scenariosFile}' (file: ${scenariosFile}); cases/soft-no.yaml is already written; delete it by hand and run the move again`,
			);
			// Nothing is lost: the source and the scenario are as they were,
			// and the destination is the duplicate the message names.
			expect(
				(await readCases(forgeDirectory, "polite-rejection")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["polite-rejection-01"]);
			expect(
				(await readCases(forgeDirectory, "soft-no")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["soft-no-01"]);
			expect((await readScenarios(forgeDirectory))[0]?.id).toBe(
				"polite-rejection",
			);
		} finally {
			await chmod(scenariosFile, 0o644);
		}
	});
});

describe("llm-tests-forge move --scenario: when suite.yaml cannot be rewritten", () => {
	test("the failure lists what is already written and the two hand steps", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection"],
		});
		const suiteFile = join(forgeDirectory, "suite.yaml");
		await chmod(suiteFile, 0o444);
		try {
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--scenario", "polite-rejection", "soft-no"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: cannot write: EACCES: permission denied, open '${suiteFile}' (file: ${suiteFile}); already written: cases/soft-no.yaml, scenarios.yaml; change polite-rejection to soft-no in suite.include by hand, then delete cases/polite-rejection.yaml`,
			);
			expect((await readScenarios(forgeDirectory))[0]?.id).toBe("soft-no");
			expect(
				(await readCases(forgeDirectory, "soft-no")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["soft-no-01"]);
			expect(
				(await readCases(forgeDirectory, "polite-rejection")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["polite-rejection-01"]);
		} finally {
			await chmod(suiteFile, 0o644);
		}
	});
});

describe("llm-tests-forge move --case: when the source cannot be rewritten", () => {
	test("the failure names the copy already in the destination and what to remove by hand", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "polite-rejection"),
		]);
		const sourceFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await chmod(sourceFile, 0o444);
		try {
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: cannot write: EACCES: permission denied, open '${sourceFile}' (file: ${sourceFile}); huge-signature-01 is already written into cases/huge-signature.yaml; remove polite-rejection-01 from cases/polite-rejection.yaml by hand`,
			);
			expect(
				(await readCases(forgeDirectory, "huge-signature")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["huge-signature-01"]);
			expect(
				(await readCases(forgeDirectory, "polite-rejection")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["polite-rejection-01", "polite-rejection-02"]);
		} finally {
			await chmod(sourceFile, 0o644);
		}
	});
});

describe("llm-tests-forge move --case: when the source cannot be removed", () => {
	test("the failure names the file and what is already written, and a retry is refused rather than writing a second copy", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "huge-signature",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
		]);
		await writeCases(forgeDirectory, "huge-signature", [
			CASE("huge-signature-01", "huge-signature"),
		]);
		// The destination file exists, so rewriting it needs no directory
		// write; removing the source does, and the directory refuses it.
		const casesDirectory = join(forgeDirectory, "cases");
		const sourceFile = join(casesDirectory, "polite-rejection.yaml");
		await chmod(casesDirectory, 0o555);
		try {
			let { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: cannot remove: EACCES: permission denied, unlink '${sourceFile}'; huge-signature-02 is already written into cases/huge-signature.yaml; delete cases/polite-rejection.yaml by hand (file: ${sourceFile})`,
			);
			expect(
				(await readCases(forgeDirectory, "huge-signature")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["huge-signature-01", "huge-signature-02"]);

			// The same case is now in both files. Running the move again
			// used to write it a third time, under -03.
			({ context, out } = await ctxIn(cwd));
			expect(
				await run(
					["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				'error: case "polite-rejection-01" has the same input as "huge-signature-02", already in scenario "huge-signature"; delete one of them (id: polite-rejection-01)',
			);
			expect(
				(await readCases(forgeDirectory, "huge-signature")).map(
					(caseEntry) => caseEntry.id,
				),
			).toEqual(["huge-signature-01", "huge-signature-02"]);
		} finally {
			await chmod(casesDirectory, 0o755);
		}
	});
});

describe("llm-tests-forge move usage", () => {
	test("neither form, both forms, a half form and stray arguments are usage errors", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedScenario(cwd);
		const lines = [
			["move"],
			["move", "--scenario", "a", "b", "--case", "x", "--to", "b"],
			["move", "--case", "x"],
			["move", "--to", "b"],
			["move", "--scenario", "a"],
			["move", "--scenario", "a", "b", "c"],
			["move", "--case", "x", "--to", "b", "c"],
		];
		for (const argv of lines) {
			const { context, out } = await ctxIn(cwd);
			expect(await run(argv, context)).toBe(2);
			expect(out.at(-1)).toStartWith("error: ");
		}
		const { context, out } = await ctxIn(cwd);
		expect(await run(["move"], context)).toBe(2);
		expect(out.at(-1)).toBe(
			"error: move takes either --scenario <old> <new> or --case <id> --to <scenario>",
		);
	});
});
