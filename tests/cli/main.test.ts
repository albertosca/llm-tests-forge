import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { CliContext } from "../../src/cli/context";
import { createContext } from "../../src/cli/context";
import { createInterruptibleReader } from "../../src/cli/interruptible-stdin";
import { COMMANDS, drafterFlag, run, USAGE } from "../../src/cli/main";
import { ForgeError } from "../../src/core/errors";
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
import { readProject } from "../../src/core/project";
import { ReportSchema } from "../../src/core/report";
import { FORGE_VERSION } from "../../src/core/version";
import {
	EMPTY_CONFIG_DIRECTORY,
	mainWithTestDefaults as main,
} from "../helpers/main";
import { projectWith } from "../helpers/project";
import { fixturePath, REPOSITORY } from "../helpers/repository";

/** An unambiguously old timestamp: any real write resets a file's mtime to
 * "now", which is trivially distinguishable from this regardless of the
 * filesystem's mtime resolution — unlike comparing two mtimes taken moments
 * apart, which a coarse clock could report as equal by coincidence. */
const LONG_AGO = new Date("2000-01-01T00:00:00Z");

const MODEL = `fake/${fixturePath("cli-responses.json")}`;

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
		expect(out).toEqual(["dedupe: polite-rejection: 1 marked as duplicates"]);
		expect(
			(await readCases(forgeDirectory, "polite-rejection"))[1]?.duplicate_of,
		).toBe("polite-rejection-01");

		({ context, out } = await ctxIn(cwd));
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);
		// Nothing left over, so nothing to explain after the count.
		expect(out.at(-1)).toBe(
			"review: approved 2 pending case(s) of polite-rejection",
		);
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
			"no drafter: pass --drafter provider/model, set FORGE_DRAFTER, or set defaults.drafter in forge.yaml",
		);
		const { context, out } = await ctxIn(directory);
		expect(await run(["describe", "text", "--model", "fake/x"], context)).toBe(
			2,
		);
		expect(out.join("\n")).toContain("Unknown option '--model'");
	});

	test("USAGE's emit line names the target kind's shim, not python's file", () => {
		const emitLine = USAGE.split("\n").find((line) =>
			line.startsWith("  emit "),
		);
		expect(emitLine).toEndWith(
			"approved cases -> .forge/promptfooconfig.yaml + the target kind's shim, or cases.jsonl",
		);
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

	test("a space after the comma is ignored, and a bad kind is named without its padding", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		const { context: badContext, out: badOut } = await ctxIn(cwd);
		expect(
			await run(["scenarios", "--kinds", "happy, bogus "], badContext),
		).toBe(2);
		expect(badOut.at(-1)).toBe(
			'error: --kinds "bogus" is not valid; choose from: happy, edge, ambiguous, out_of_scope, adversarial, language',
		);

		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios", "--kinds", "happy, edge"], context)).toBe(0);
	});

	test("the summary counts the new scenarios against the total, and a second run counts only its own", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		let { context } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], context)).toBe(0);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);

		const first = await ctxIn(cwd);
		expect(await run(["scenarios"], first.context)).toBe(0);
		const file = join(forgeDirectory, "scenarios.yaml");
		expect(first.out).toEqual([
			`scenarios: 6 new pending (6 total) -> ${file}`,
		]);
		const second = await ctxIn(cwd);
		expect(await run(["scenarios"], second.context)).toBe(0);
		expect(second.out).toEqual([
			`scenarios: 6 new pending (12 total) -> ${file}`,
		]);
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

describe("cases: which scenarios get cases, and what the summary line says", () => {
	test("only approved and edited scenarios are generated for; the line counts the new cases against the total", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(
			forgeDirectory,
			(["pending", "rejected", "approved", "edited"] as const).map(
				(status) => ({
					id: `${status}-one`,
					kind: "happy" as const,
					oracle: "label" as const,
					description: "d",
					status,
				}),
			),
		);
		// One case already on disk with the first input the model returns:
		// it is not counted as new.
		await writeCases(forgeDirectory, "edited-one", [
			{
				id: "edited-one-01",
				scenario: "edited-one",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["cases"], context)).toBe(0);
		expect(out).toStrictEqual([
			"cases: approved-one: 2 new pending (2 total)",
			"cases: edited-one: 1 new pending (2 total)",
		]);
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

		// Nothing is approved, so the file is not touched at all.
		const casesFile = join(forgeDirectory, "cases", "imported.yaml");
		await utimes(casesFile, LONG_AGO, LONG_AGO);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "imported", "--all"], context),
		).toBe(0);
		expect((await stat(casesFile)).mtime.getTime()).toBe(LONG_AGO.getTime());

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
		expect(out.at(-1)).toBe(`error: file not found (file: ${missing})`);
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
		expect(out.at(-1)).toContain(
			'--oracle "bogus" is not valid; choose one of: label, fields, rubric',
		);
	});
});

describe("drafterFlag", () => {
	test("reads --drafter from raw argv", () => {
		expect(drafterFlag(["describe", "x", "--drafter", "anthropic/haiku"])).toBe(
			"anthropic/haiku",
		);
	});

	test("reads --drafter when it is the very first argument", () => {
		expect(drafterFlag(["--drafter", "anthropic/haiku"])).toBe(
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
	}, 30_000);

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

	test("describe joins an unquoted multi-word description with single spaces", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { context } = await ctxIn(cwd);
		const prompts: string[] = [];
		context.llm = {
			generate: async (request) => {
				prompts.push(request.prompt);
				throw new Error("stop after the prompt");
			},
		};
		expect(
			await run(
				["describe", "The bot", "classifies", "hiring emails"],
				context,
			),
		).toBe(1);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The bot classifies hiring emails");
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

	test("estimate refuses, naming feature.yaml, before it looks for a suite", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);

		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(1);
		expect(out).toEqual([
			`error: feature is pending; run \`llm-tests-forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		]);
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
		// No project, so there is nothing to register it in: the message
		// goes straight from the advice to the file it names.
		expect(out.at(-1)).toBe(
			`error: feature "classify-email" is already approved; describe would overwrite the reviewed description and its invariants — re-run with --force to replace it (file: ${featurePath}, id: classify-email)`,
		);
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

	test("in a project, the refusal for a reviewed suite that is not registered says how to register it; a registered one does not", async () => {
		// A suite copied in before init: reviewed, but not in forge.yaml.
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/kept]\n",
		);
		for (const name of ["classify", "kept"])
			await cp(
				fixturePath("extract-questions/.forge"),
				join(root, "evals", name, ".forge"),
				{ recursive: true },
			);
		const describeIn = async (directory: string): Promise<string[]> => {
			const lines: string[] = [];
			expect(
				await main(["describe", "--drafter", MODEL, "anything"], {
					cwd: directory,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(1);
			return lines;
		};
		const unregistered = await describeIn(join(root, "evals", "classify"));
		expect(unregistered.join("\n")).toContain(
			"re-run with --force to replace it. This suite is not registered in forge.yaml: to register it without describing it again, add its path to suites: in forge.yaml (for example `suites: [evals/classify]`, or, when suites is already a block list, add a `- evals/classify` line with the same indentation as the existing entries)",
		);
		const registered = await describeIn(join(root, "evals", "kept"));
		// Registered: the advice runs straight into the file it names.
		expect(registered.join("\n")).toContain(
			"re-run with --force to replace it (file: ",
		);
		expect(registered.join("\n")).not.toContain("not registered");
	});

	test("a forge.yaml that registering refuses still gets the refusal for a reviewed suite, with registering's reason after it", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\ndefaults:\n  judges: &list [evals/kept]\nsuites: *list\n",
		);
		await cp(
			fixturePath("extract-questions/.forge"),
			join(root, "evals", "classify", ".forge"),
			{ recursive: true },
		);
		const lines: string[] = [];
		expect(
			await main(["describe", "--drafter", MODEL, "anything"], {
				cwd: join(root, "evals", "classify"),
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(1);
		// Each file is named once: forge.yaml in the note, feature.yaml at the end.
		const forgeYaml = join(root, "forge.yaml");
		const featureYaml = join(
			root,
			"evals",
			"classify",
			".forge",
			"feature.yaml",
		);
		expect(lines.at(-1)).toBe(
			`error: feature "extract-job-application-questions" is already approved; describe would overwrite the reviewed description and its invariants — re-run with --force to replace it. This suite may not be registered in ${forgeYaml}: suites: is a YAML alias, which registering cannot extend; add its path to suites: in forge.yaml (for example \`suites: [evals/classify]\`, or, when suites is already a block list, add a \`- evals/classify\` line with the same indentation as the existing entries) (file: ${featureYaml}, id: extract-job-application-questions)`,
		);
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
	}, 30_000);

	test("a Ctrl+C while $EDITOR runs belongs to the editor: the pass neither ends nor exits, the edit lands, and Ctrl+C works again afterwards", async () => {
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
		const started = join(cwd, "editor-started");
		const release = join(cwd, "editor-release");
		// Says it is open, waits to be let go, then edits the description.
		const editor = join(cwd, "waiting-editor.sh");
		await writeFile(
			editor,
			`#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${release}" ]; do sleep 0.02; done\nsed 's|^description: d$|description: d2|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(editor, 0o755);
		const out: string[] = [];
		const exits: number[] = [];
		const answers = ["edit"];
		const reader = createInterruptibleReader({
			readLine: async () => answers.shift() ?? "",
			stdout: (line) => out.push(line),
			exit: (code) => exits.push(code),
		});
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: reader.startInteractivePass,
		});
		context.stdout = (line) => out.push(line);
		await withEditor(editor, async () => {
			const reviewing = run(["review", "--only", "scenarios"], context);
			while (!(await Bun.file(started).exists())) await Bun.sleep(10);
			// Two presses inside the editor: once would have ended the pass,
			// twice exited 130.
			reader.interrupt();
			reader.interrupt();
			await writeFile(release, "");
			expect(await reviewing).toBe(0);
		});
		expect(exits).toEqual([]);
		expect(out.join("\n")).not.toContain("interrupted:");
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => [
				scenario.description,
				scenario.status,
			]),
		).toEqual([["d2", "edited"]]);
		reader.interrupt();
		expect(out.at(-1)).toBe(
			"interrupted: no more answers; the decisions already taken are written",
		);
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);
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

describe("dedupe: a scenario that is not among the existing ones", () => {
	test("is named with its id even when other scenarios exist, and nothing is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["dedupe", "--scenario", "totally-bogus"], context)).toBe(
			1,
		);
		expect(out).toEqual([
			'error: scenario "totally-bogus" not found (id: totally-bogus)',
		]);
		expect(await readCases(forgeDirectory, "polite-rejection")).toHaveLength(1);
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
		// The decision that did not land leaves its item as pending as the
		// pass found it, so "still pending" counts it: "0 still pending"
		// here claimed both cases had been taken care of.
		expect(out.at(-1)).toBe(
			"review: 2 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 1 still pending; 1 decision(s) not written",
		);
		await expect(stat(hugeSignaturePath)).rejects.toThrow();
		const politeRejection = await readCases(forgeDirectory, "polite-rejection");
		expect(
			politeRejection.map((caseEntry) => [caseEntry.id, caseEntry.status]),
		).toEqual([["polite-rejection-01", "approved"]]);
	});
});

describe("review: a write-back that fails part-way names what landed and what did not", () => {
	test("a second Ctrl+C, then the middle of three cases files cannot be written: no exit 130, and the error lists the file written, the one that failed and the one never reached", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		const scenarioIds = ["huge-signature", "polite-rejection", "zero-reply"];
		await writeScenarios(
			forgeDirectory,
			scenarioIds.map((id) => ({
				id,
				kind: "happy" as const,
				oracle: "label" as const,
				description: "d",
				status: "approved" as const,
			})),
		);
		for (const id of scenarioIds)
			await writeCases(forgeDirectory, id, [
				{
					id: `${id}-01`,
					scenario: id,
					input: { email: id },
					expected: { label: "rejection" },
					status: "pending",
					generated_by: "hand",
				},
			]);
		const readOnly = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await chmod(readOnly, 0o444);

		const out: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: async () => "approve",
			stdout: (line) => out.push(line),
			exit: (code) => exits.push(code),
		});
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: () => {
				const pass = reader.startInteractivePass();
				return {
					read: pass.read,
					whileEditing: pass.whileEditing,
					// Two Ctrl+C as soon as the write-back has begun: the first
					// ends the input, the second is held until the write ends.
					whileWriting: <Result>(work: () => Promise<Result>) => {
						const writing = pass.whileWriting(work);
						reader.interrupt();
						reader.interrupt();
						return writing;
					},
				};
			},
		});
		context.stdout = (line) => out.push(line);
		try {
			expect(await run(["review", "--only", "cases"], context)).toBe(1);
		} finally {
			await chmod(readOnly, 0o644);
		}
		expect(exits).toEqual([]);
		expect(out.at(-1)).toBe(
			`error: cannot write: EACCES: permission denied, open '${readOnly}' (file: ${readOnly}); the write-back stopped there: already written: cases/huge-signature.yaml; not written: cases/polite-rejection.yaml, cases/zero-reply.yaml`,
		);
		const statuses = [];
		for (const id of scenarioIds)
			statuses.push((await readCases(forgeDirectory, id))[0]?.status);
		expect(statuses).toEqual(["approved", "pending", "pending"]);
	});
});

describe("review: startInteractivePass arms end-of-input only for the interactive path", () => {
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
		const reader = createInterruptibleReader({
			readLine: async () => "approve",
			stdout: () => {},
			exit: () => {},
		});
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: () => {
				interactivePassCalls += 1;
				return reader.startInteractivePass();
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

	test("a real $EDITOR killed by Ctrl+C skips the case on screen and every later one, and the decision taken before it is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(
			forgeDirectory,
			"polite-rejection",
			["01", "02", "03"].map((number) => ({
				id: `polite-rejection-${number}`,
				scenario: "polite-rejection",
				input: { email: number },
				expected: { label: "rejection" },
				status: "pending" as const,
				generated_by: "hand",
			})),
		);
		// A stand-in for an editor that dies of the Ctrl+C: it sends SIGINT
		// to itself only, never to the test process.
		const editor = join(cwd, "editor-killed-by-sigint.sh");
		await writeFile(editor, "#!/bin/sh\nkill -INT $$\n");
		await chmod(editor, 0o755);
		const { context, out } = await ctxIn(cwd, ["approve", "edit"]);
		const original = process.env.EDITOR;
		process.env.EDITOR = editor;
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
		expect(out.some((line) => line.startsWith("cannot apply:"))).toBe(false);
		expect(out).not.toContain("--- case polite-rejection-03 ---");
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 2 skipped, 0 re-opened, 2 still pending",
		);
		const onDisk = await readCases(forgeDirectory, "polite-rejection");
		expect(onDisk.map((caseEntry) => caseEntry.status)).toEqual([
			"approved",
			"pending",
			"pending",
		]);
	}, 30_000);

	test("a Ctrl+C while an expected value is asked for ends the pass like the prompt and the editor: no 'try again', no 'cannot apply', nothing re-shown", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
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
		const out: string[] = [];
		const exits: number[] = [];
		let reads = 0;
		const reader = createInterruptibleReader({
			// "approve" for the first case, then a Ctrl+C while its expected
			// label is being asked for.
			readLine: () => {
				reads += 1;
				if (reads === 1) return Promise.resolve("approve");
				queueMicrotask(() => reader.interrupt());
				return new Promise<string>(() => {});
			},
			stdout: (line) => out.push(line),
			exit: (code) => exits.push(code),
		});
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: reader.startInteractivePass,
		});
		context.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);
		expect(exits).toEqual([]);
		expect(out.some((line) => line.includes("try again"))).toBe(false);
		expect(out.some((line) => line.startsWith("cannot apply:"))).toBe(false);
		expect(
			out.filter((line) => line === "--- case polite-rejection-01 ---"),
		).toHaveLength(1);
		expect(out).not.toContain("--- case polite-rejection-02 ---");
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 0 edited, 2 skipped, 0 re-opened, 2 still pending",
		);
	});

	test("the write-back and its report run inside the pass's whileWriting, where a second Ctrl+C lets the write finish", async () => {
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

		const out: string[] = [];
		const reader = createInterruptibleReader({
			readLine: async () => "approve",
			stdout: () => {},
			exit: () => {},
		});
		const statuses: string[] = [];
		let linesBeforeWriting = -1;
		const statusOnDisk = async () =>
			(await readCases(forgeDirectory, "polite-rejection"))[0]?.status ?? "";
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: () => {
				const pass = reader.startInteractivePass();
				return {
					read: pass.read,
					whileEditing: pass.whileEditing,
					whileWriting: async <Result>(work: () => Promise<Result>) => {
						statuses.push(await statusOnDisk());
						linesBeforeWriting = out.length;
						const result = await pass.whileWriting(work);
						statuses.push(await statusOnDisk());
						return result;
					},
				};
			},
		});
		context.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);

		// Nothing was written before the guarded span began, all of it was
		// written by its end, and the summary line was printed inside it.
		expect(statuses).toEqual(["pending", "approved"]);
		expect(out.slice(linesBeforeWriting)).toEqual([
			"Next: run llm-tests-forge estimate, then emit.",
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
		]);
	});

	test("rejecting the only case does not send the person to estimate, which would refuse", async () => {
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
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => "reject",
		});
		context.stdout = (line) => out.push(line);

		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);

		expect(out.at(-2)).toBe("Next: run llm-tests-forge cases.");
	});

	test("a pass over cases says once what the Expected is for, and each case lists the feature's invariants", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeFeature(forgeDirectory, {
			...FEATURE,
			invariants: ["a receipt alone is an acknowledgement"],
		});
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
		const { context, out } = await ctxIn(cwd, ["s", "s"]);
		expect(await run(["review"], context)).toBe(0);

		const text = out.join("\n");
		expect(out[0]).toContain("You are setting the right answer for each case");
		expect(text.split("You are setting the right answer").length - 1).toBe(1);
		expect(text.indexOf("You are setting")).toBeLessThan(
			text.indexOf("--- case polite-rejection-01 ---"),
		);
		expect(
			text.split("Rules the answer must respect (the feature's invariants):")
				.length - 1,
		).toBe(2);
		expect(text).toContain("  • a receipt alone is an acknowledgement");
	});

	test("a pass holding a scenario and a case still prints the preface", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "later-one",
				kind: "edge",
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
		]);
		const { context, out } = await ctxIn(cwd, ["s", "s"]);
		expect(await run(["review"], context)).toBe(0);
		expect(out.join("\n")).toContain("You are setting the right answer");
	});

	test("a pass with no case to judge prints no preface", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		const { context, out } = await ctxIn(cwd, ["s"]);
		expect(await run(["review"], context)).toBe(0);
		expect(out.join("\n")).not.toContain("You are setting the right answer");
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
		const reader = createInterruptibleReader({
			readLine: async () => "",
			stdout: () => {},
			exit: () => {},
		});
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: reader.read,
			startInteractivePass: () => {
				interactivePassCalls += 1;
				return reader.startInteractivePass();
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
	}, 30_000);

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
	}, 30_000);
});

describe("import: a line that cannot be imported is named, and the rest still land", () => {
	test("a line that is not JSON is reported with its number and reason, and the count says one was skipped", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, []);
		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\nnot json at all\n');
		const { context, out } = await ctxIn(cwd);

		expect(await run(["import", jsonl], context)).toBe(0);

		expect(out).toEqual([
			"import: skipped line 2: not valid JSON",
			"import: 1 new pending cases without expected (1 skipped)",
		]);
		expect(
			(await readCases(forgeDirectory, "imported")).map(
				(caseEntry) => caseEntry.id,
			),
		).toEqual(["imported-01"]);
	});
});

describe("review: the feature file cannot be written after a scenario was decided", () => {
	test("the error lists the scenarios file among the ones not written, since it is written right after the feature", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, { ...FEATURE, status: "pending" });
		await writeScenarios(forgeDirectory, [
			{
				id: "happy-path",
				kind: "happy" as const,
				oracle: "label" as const,
				description: "d",
				status: "pending" as const,
			},
		]);
		const featurePath = join(forgeDirectory, "feature.yaml");
		await chmod(featurePath, 0o444);
		const { context, out } = await ctxIn(cwd, ["approve", "approve"]);

		try {
			expect(await run(["review"], context)).toBe(1);
		} finally {
			await chmod(featurePath, 0o644);
		}

		expect(out.at(-1)).toBe(
			`error: cannot write: EACCES: permission denied, open '${featurePath}' (file: ${featurePath}); the write-back stopped there: already written: nothing; not written: feature.yaml, scenarios.yaml`,
		);
		expect((await readScenarios(forgeDirectory))[0]?.status).toBe("pending");
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

describe("review: each item says where the pass is and what is being judged", () => {
	const settledCase = (status: "approved" | "edited") => ({
		id: "polite-rejection-01",
		scenario: "polite-rejection",
		input: { email: "one" },
		expected: { label: "rejection" },
		status,
		generated_by: "t",
	});

	test("a scenario with no cases is still pointed at cases while another has approved ones", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "empty-one",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			settledCase("approved"),
		]);
		await writeCases(forgeDirectory, "empty-one", []);
		const { context, out } = await ctxIn(cwd, []);
		expect(await run(["review"], context)).toBe(0);
		expect(out.at(-2)).toBe("Next: run llm-tests-forge cases.");
	});

	test("an edited case counts as ready for estimate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			settledCase("edited"),
		]);
		const { context, out } = await ctxIn(cwd, []);
		expect(await run(["review"], context)).toBe(0);
		expect(out.at(-2)).toBe("Next: run llm-tests-forge estimate, then emit.");
	});

	test("a pass over two pending cases numbers them and explains the input, the proposed expected and the keys", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "We will not proceed." },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "Thanks for applying!" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd, ["s", "s"]);
		expect(
			await run(["review", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(out).toContain("--- case polite-rejection-01 ---");
		const screen = out.join("\n");
		expect(screen).toContain(
			'Item 1 of 2 · a case of scenario "polite-rejection"',
		);
		expect(screen).toContain(
			'Item 2 of 2 · a case of scenario "polite-rejection"',
		);
		expect(screen).toContain("Scenario: d");
		expect(screen).toContain("  email: We will not proceed.");
		expect(screen).toContain(
			"Expected, proposed by t (you confirm or correct it):",
		);
		expect(screen).toContain(
			"Expected: none yet; approve or edit will ask you for it.",
		);
		expect(screen).toContain("Valid labels: rejection, acknowledgement");
		expect(screen).toContain(
			"keys: a approve · r reject · e edit · s skip (Enter asks before skipping)",
		);
		expect(screen).not.toContain("generated_by:");
		expect(out.at(-1)).toStartWith("review: 0 approved");
	});
});

describe("review: the pass ends by saying what is next", () => {
	test("a skipped item sends the person back to review, and the summary stays the last line", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd, ["s"]);
		expect(
			await run(["review", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(out.at(-2)).toBe(
			"Next: 1 item(s) still pending: run llm-tests-forge review again.",
		);
		expect(out.at(-1)).toStartWith("review: 0 approved");
	});

	test("an approved scenario with no cases yet points at cases", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedScenario(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review"], context)).toBe(0);
		expect(out).toEqual([
			"Next: run llm-tests-forge cases.",
			"review: nothing pending",
		]);
	});

	test("a scenario that is not the one being reviewed is not asked for cases", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
			{
				id: "other",
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
				status: "approved",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(out).toEqual([
			"Next: run llm-tests-forge estimate, then emit.",
			"review: nothing pending",
		]);
	});
});

describe("review: a cases file with no cases does not count as having cases", () => {
	test("an approved scenario whose cases file is empty still points at cases", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", []);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review"], context)).toBe(0);
		expect(out).toEqual([
			"Next: run llm-tests-forge cases.",
			"review: nothing pending",
		]);
	});
});

describe("review --all: both reasons for leaving a case pending are reported on one line", () => {
	test("the no-expected note and the off-oracle note are joined by a semicolon", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				status: "pending",
				generated_by: "t",
			},
			{
				id: "polite-rejection-02",
				scenario: "polite-rejection",
				input: { email: "two" },
				expected: { label: "not-a-label" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], context),
		).toBe(0);
		expect(out.at(-1)).toBe(
			"review: approved 0 pending case(s) of polite-rejection; 1 left pending (no expected set — run `llm-tests-forge review --scenario polite-rejection` to fill them in); 1 left pending (expected does not match the label oracle — see above)",
		);
	});
});

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
		// The scenario is written once, by the first import.
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => scenario.id),
		).toEqual(["imported"]);
	});

	test("a second import that names no --oracle is accepted: there is nothing to change", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { forgeDirectory, path } = await importable(cwd, "prod.jsonl", "one");
		const { context: firstContext } = await ctxIn(cwd);
		expect(await run(["import", path], firstContext)).toBe(0);

		const second = join(cwd, "more.jsonl");
		await writeFile(second, '{"email":"two"}\n');
		const { context, out } = await ctxIn(cwd);
		expect(await run(["import", second], context)).toBe(0);
		expect(out.at(-1)).toBe(
			"import: 1 new pending cases without expected (0 skipped)",
		);
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
	}, 30_000);
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
		// A scenario that has cases is not "no cases yet".
		expect(out.filter((line) => line.includes("no cases yet"))).toEqual([]);
		// One scenario was pending and was decided, so the pass itself left
		// nothing pending — the two it reports are the two it re-opened.
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 2 re-opened, 2 still pending",
		);
	}, 30_000);
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

		// The file held no decision of this pass, only the re-opens the
		// oracle change would have made: the line used to say "its decisions
		// were not written" and leave the oracle change itself unannounced.
		expect(out).toContain(
			"review: cases/polite-rejection.yaml changed on disk during the pass; its cases were not re-opened",
		);
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric (written to scenarios.yaml)",
		);
		expect(
			out.some((line) => line.includes("its decisions were not written")),
		).toBe(false);
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
	}, 30_000);

	test("a changed cases file holding both a decision and re-opens names both losses, and the oracle change is still on the record", async () => {
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
		const casesOnDisk = [
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
				expected: { rubric: "Declines politely." },
				status: "pending" as const,
				generated_by: "hand",
			},
		];
		await writeCases(forgeDirectory, "polite-rejection", casesOnDisk);
		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const answers = ["edit", "approve"];
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			// "edit" turns the scenario's oracle into rubric; before the case's
			// "approve", the cases file is rewritten by "someone else".
			stdin: async () => {
				const answer = answers.shift() ?? "";
				if (answer === "approve") {
					await writeCases(forgeDirectory, "polite-rejection", casesOnDisk);
					await utimes(casesPath, LONG_AGO, LONG_AGO);
				}
				return answer;
			},
		});
		context.stdout = (line) => out.push(line);
		await editOracleToRubric(cwd, out, context);

		expect(out).toContain(
			"review: cases/polite-rejection.yaml changed on disk during the pass; its decisions were not written and its cases were not re-opened",
		);
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric (written to scenarios.yaml)",
		);
		expect((await readScenarios(forgeDirectory))[0]?.oracle).toBe("rubric");
		const onDisk = await readCases(forgeDirectory, "polite-rejection");
		expect(onDisk.map((caseEntry) => caseEntry.status)).toEqual([
			"approved",
			"pending",
		]);
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 1 still pending; 1 decision(s) not written",
		);
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);

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
	}, 30_000);
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
	}, 30_000);

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
			`review: ${join(forgeDirectory, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; a pass offers only the first pending one — fix the file`,
		);
	});

	test("an approved entry and a pending twin under one id: the decision lands on the pending one that was offered, and the approved one survives", async () => {
		// The decision used to be matched back by id alone, so it replaced
		// the first entry under that id -- the approved one, whose input and
		// review were destroyed -- while the offered pending twin stayed
		// pending, and the summary counted it as decided.
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "already approved" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "hand",
			},
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "the pending twin" },
				expected: { label: "acknowledgement" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { context, out } = await ctxIn(cwd, ["reject"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				context,
			),
		).toBe(0);
		expect(out).toContain(
			`review: ${join(forgeDirectory, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; a pass offers only the first pending one — fix the file`,
		);
		// The case is offered as the frame shows it: its input and its proposed
		// expected, which is what tells the pending twin from the approved one.
		expect(out.join("\n")).toContain(
			"Input:\n  email: the pending twin\nExpected, proposed by hand (you confirm or correct it):\n  label: acknowledgement",
		);
		const cases = await readCases(forgeDirectory, "polite-rejection");
		expect(
			cases.map((caseEntry) => [caseEntry.input.email, caseEntry.status]),
		).toEqual([
			["already approved", "approved"],
			["the pending twin", "rejected"],
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 1 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
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
			`review: ${join(forgeDirectory, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; a pass offers only the first pending one — fix the file`,
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
	}, 30_000);
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
	}, 30_000);
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
	}, 30_000);
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
	}, 30_000);
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
		expect(text).toMatch(
			/^ {2}total {2,}\$\d+\.\d{6}–\$\d+\.\d{6} \(point \$\d+\.\d{6}\)$/m,
		);
		expect(text).toContain(
			"note: tokens are counted as characters/4 and shown as a range calibrated on recorded runs; output is",
		);
		expect(text).toContain("note: application prompt not counted");
		// Every selected item is approved: nothing was excluded, so nothing says so.
		expect(text).not.toContain("excluded");
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
	test("in a project, the missing suite.yaml's example uses the project's language", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: ruby\nsuites: [evals/a]\n",
		);
		const suiteDirectory = join(root, "evals", "a");
		await writeFeature(join(suiteDirectory, ".forge"), FEATURE);
		for (const verb of ["emit", "estimate"]) {
			const lines: string[] = [];
			expect(
				await main([verb], {
					cwd: suiteDirectory,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(1);
			expect(lines.join("\n")).toContain("  kind: ruby ");
			expect(lines.join("\n")).toContain("  entry: forge_target.rb ");
		}
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
		// Exactly these two lines: an http-only warning slot that is empty
		// must print nothing, not the word null.
		expect(out).toStrictEqual([
			`emit: wrote ${join(forgeDirectory, "promptfooconfig.yaml")} (2 cases, 2 scenarios, 1 target model, 1 judge)`,
			`emit: wrote ${join(forgeDirectory, "forge_target.py")}; edit run_application() to call your application`,
		]);
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
	test("ruby: writes forge_target.rb, runs it through exec, and keeps it on a second emit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { kind: "ruby", models: ["anthropic/claude-haiku-4-5"] },
		});
		const shim = join(forgeDirectory, "forge_target.rb");
		const first = await ctxIn(cwd);
		expect(await run(["emit"], first.context)).toBe(0);
		expect(await readFile(shim, "utf8")).toContain('INPUTS = ["email"].freeze');
		const parsedConfig = parse(
			await readFile(join(forgeDirectory, "promptfooconfig.yaml"), "utf8"),
		);
		expect(parsedConfig.providers[0].id).toBe("exec: ruby forge_target.rb");
		expect(first.out).toContain(
			`emit: wrote ${shim}; edit run_application to call your application`,
		);
		await writeFile(shim, "# mine\n");
		const second = await ctxIn(cwd);
		expect(await run(["emit"], second.context)).toBe(0);
		expect(await readFile(shim, "utf8")).toBe("# mine\n");
		expect(second.out).toContain(`emit: kept existing ${shim}`);
	});
	test.each([
		[
			"javascript",
			undefined,
			"; edit runApplication() to call your application",
		],
		[
			"typescript",
			undefined,
			"; edit runApplication() to call your application",
		],
		["elixir", "mix.exs", "; edit run_application/2 to call your application"],
		[
			"rust",
			"Cargo.toml",
			"; edit run_application in src/main.rs to call your application, then run `cargo build --release` in that directory",
		],
	] as const)(
		"%s: the last line says what to edit next",
		async (kind, manifest, hint) => {
			const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
			if (manifest !== undefined) {
				await writeFile(
					join(cwd, manifest),
					manifest === "mix.exs"
						? "defmodule Demo.MixProject do\nend\n"
						: '[package]\nname = "demo"\n',
				);
			}
			const forgeDirectory = await forgeWithApprovedCases(cwd);
			await writeSuite(forgeDirectory, {
				...SUITE,
				target: { kind, models: ["anthropic/claude-haiku-4-5"] },
			});
			const { context, out } = await ctxIn(cwd);
			expect(await run(["emit"], context)).toBe(0);
			expect(out.at(-1)).toEndWith(hint);
		},
	);
	test("go: writes go.mod and main.go under forge_target/, pointing at the project's module, and says how to build", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await writeFile(join(cwd, "go.mod"), "module example.com/myapp\n");
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { kind: "go", models: ["anthropic/claude-haiku-4-5"] },
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(await readdir(join(forgeDirectory, "forge_target"))).toEqual([
			"go.mod",
			"main.go",
		]);
		expect(
			await readFile(join(forgeDirectory, "forge_target", "go.mod"), "utf8"),
		).toContain("// replace example.com/myapp => ../..");
		const parsedConfig = parse(
			await readFile(join(forgeDirectory, "promptfooconfig.yaml"), "utf8"),
		);
		expect(parsedConfig.providers[0].id).toBe(
			"exec: ./forge_target/forge_target",
		);
		expect(out.at(-1)).toBe(
			`emit: wrote ${join(forgeDirectory, "forge_target", "go.mod")}, ${join(forgeDirectory, "forge_target", "main.go")}; edit runApplication in main.go to call your application, then run \`GOWORK=off go build -o forge_target .\` in that directory`,
		);
	});
	test("each shim file is kept or written on its own: a go suite switched to rust gets the rust files, a deleted main.go comes back, an untouched shim is all kept", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const shimDirectory = join(forgeDirectory, "forge_target");
		const goSuite = {
			...SUITE,
			target: { kind: "go" as const, models: ["anthropic/claude-haiku-4-5"] },
		};
		await writeSuite(forgeDirectory, goSuite);
		expect(await run(["emit"], (await ctxIn(cwd)).context)).toBe(0);
		await writeFile(join(shimDirectory, "go.mod"), "// mine\n");
		const untouched = await ctxIn(cwd);
		expect(await run(["emit"], untouched.context)).toBe(0);
		expect(untouched.out.at(-1)).toBe(
			`emit: kept existing ${join(shimDirectory, "go.mod")}, ${join(shimDirectory, "main.go")}`,
		);
		await unlink(join(shimDirectory, "main.go"));
		const repaired = await ctxIn(cwd);
		expect(await run(["emit"], repaired.context)).toBe(0);
		expect(await readFile(join(shimDirectory, "go.mod"), "utf8")).toBe(
			"// mine\n",
		);
		expect(await readFile(join(shimDirectory, "main.go"), "utf8")).toContain(
			"func runApplication",
		);
		expect(repaired.out.at(-1)).toBe(
			`emit: kept existing ${join(shimDirectory, "go.mod")}; wrote ${join(shimDirectory, "main.go")}; edit runApplication in main.go to call your application, then run \`GOWORK=off go build -o forge_target .\` in that directory`,
		);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { kind: "rust", models: ["anthropic/claude-haiku-4-5"] },
		});
		const switched = await ctxIn(cwd);
		expect(await run(["emit"], switched.context)).toBe(0);
		expect(await readFile(join(shimDirectory, "Cargo.toml"), "utf8")).toContain(
			"[workspace]",
		);
		expect(
			await readFile(join(shimDirectory, "src", "main.rs"), "utf8"),
		).toContain("fn run_application");
		expect(switched.out.at(-1)).toContain(
			`emit: wrote ${join(shimDirectory, "Cargo.toml")}, ${join(shimDirectory, "src", "main.rs")}; `,
		);
	});
	test("a target.entry holding whitespace is refused before anything is written: promptfoo splits an exec command on it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: {
				kind: "ruby",
				entry: "my target.rb",
				models: ["anthropic/claude-haiku-4-5"],
			},
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out.at(-1)).toContain("target.entry must not contain whitespace");
		expect(out.at(-1)).toContain(join(forgeDirectory, "suite.yaml"));
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
	});
	test("elixir runs from the mix project above the suite, and with none is refused before anything is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const suiteDirectory = join(cwd, "evals", "classify");
		const forgeDirectory = await forgeWithApprovedCases(suiteDirectory);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: { kind: "elixir", models: ["anthropic/claude-haiku-4-5"] },
		});
		const refused = await ctxIn(suiteDirectory);
		expect(await run(["emit"], refused.context)).toBe(1);
		expect(refused.out.at(-1)).toContain(`no mix.exs above ${suiteDirectory}`);
		await expect(
			stat(join(forgeDirectory, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await writeFile(join(cwd, "mix.exs"), "defmodule App.MixProject do\n");
		const { context } = await ctxIn(suiteDirectory);
		expect(await run(["emit"], context)).toBe(0);
		const parsedConfig = parse(
			await readFile(join(forgeDirectory, "promptfooconfig.yaml"), "utf8"),
		);
		expect(parsedConfig.providers[0].id).toBe(
			`exec: sh -c 'cd "../../.." && MIX_QUIET=1 ELIXIR_ERL_OPTIONS="$ELIXIR_ERL_OPTIONS -logger default_handler [{config,#{type=>standard_error}}]" mix run "evals/classify/.forge/forge_target.exs" "$@"' forge_target`,
		);
		expect(
			await readFile(join(forgeDirectory, "forge_target.exs"), "utf8"),
		).toContain('@inputs ["email"]');
	});
	test("exec and http reach code the person already runs: no shim is written", async () => {
		for (const target of [
			{
				kind: "exec" as const,
				command: "./run.sh",
				models: ["anthropic/claude-haiku-4-5"],
			},
			{
				kind: "http" as const,
				url: "http://localhost:4000/classify",
				models: ["anthropic/claude-haiku-4-5"],
			},
		]) {
			const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
			const forgeDirectory = await forgeWithApprovedCases(cwd);
			await writeSuite(forgeDirectory, { ...SUITE, target });
			const { context, out } = await ctxIn(cwd);
			expect(await run(["emit"], context)).toBe(0);
			const written = await readdir(forgeDirectory);
			expect(written.filter((name) => name.startsWith("forge_target"))).toEqual(
				[],
			);
			expect(out.join("\n")).not.toContain("forge_target");
			expect(out.join("\n")).not.toContain("warning");
		}
	});
	test("an http suite with two target models and no {{target_model}} is emitted with one warning line", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDirectory, {
			...SUITE,
			target: {
				kind: "http",
				url: "http://localhost:4000/classify",
				models: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"],
			},
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out.filter((line) => line.includes("warning"))).toEqual([
			"emit: warning: target.kind is http and target.models lists 2 models, but {{target_model}} appears nowhere in target.url, target.headers or target.body, so every provider sends the same request",
		]);
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
		const casesFile = join(forgeDirectory, "cases", "polite-rejection.yaml");
		expect(text).toContain(
			"error: emit refused: 2 items block it; run `llm-tests-forge review`",
		);
		expect(text).toContain(
			`; run \`llm-tests-forge review\`\n  case polite-rejection-01 is pending (${casesFile})\n  case polite-rejection-02 is pending (${casesFile})`,
		);
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
		expect(text).toContain(
			"error: emit refused: 1 item blocks it\n  scenario polite-rejection is rejected",
		);
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
	test("a target.entry with only a slash, only a backslash, or only two dots is a path too", async () => {
		for (const entry of ["sub/target.py", "sub\\target.py", "a..b.py"]) {
			const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
			const forgeDirectory = await forgeWithApprovedCases(cwd);
			await writeSuite(forgeDirectory, {
				...SUITE,
				target: { ...SUITE.target, entry },
			});
			const { context, out } = await ctxIn(cwd);
			expect(await run(["emit"], context)).toBe(1);
			expect(out.at(-1)).toContain(
				"target.entry must be a file name inside .forge, not a path",
			);
			await expect(
				stat(join(forgeDirectory, "promptfooconfig.yaml")),
			).rejects.toThrow();
		}
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
	const RESULTS = fixturePath("promptfoo-results-0.123.0.json");

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
		// report writes into the suite, so it stamps suite.yaml like the others.
		expect(
			await readFile(join(forgeDirectory, "suite.yaml"), "utf8"),
		).toStartWith(`forge_version: ${FORGE_VERSION}\n`);
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
		// (300) = 309, so 618 total; output tokens are 2 calls *
		// JUDGE_OUTPUT_TOKENS (183) = 366. The suite's one non-rubric case's
		// label ("acknowledgement", approxTokens 4) is below the label guess
		// (8), so the guess wins.
		expect(judge.estimatedDollars).toBe((618 * 1.5 + 366 * 9) / 1_000_000);
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
		expect(out.at(-1)).toContain("a config llm-tests-forge emitted");
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

	test("a baseline with two wrong fields names each as path: problem, joined by a semicolon", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const real = JSON.parse(
			await readFile(
				fixturePath("extract-questions/.forge/report.json"),
				"utf8",
			),
		);
		const bad = join(cwd, "bad.json");
		await writeFile(
			bad,
			JSON.stringify({ ...real, rows: "x", unmatched: [1] }),
		);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", bad], context)).toBe(1);
		// A nested problem is addressed by its dotted path: unmatched.0.
		expect(out.at(-1)).toMatch(
			/is not a report written by llm-tests-forge: rows: [^;]+; unmatched\.0: [^;]+ \(file: /,
		);
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

	/** A working copy of a frozen suite (its .forge, prompt.txt and results.json) to run report in. */
	async function copyOfFrozenSuite(name: string): Promise<string> {
		const cwd = await mkdtemp(join(tmpdir(), `forge-cli-${name}-`));
		await cp(fixturePath(name), cwd, { recursive: true });
		return cwd;
	}

	/** The error cell of each cost row in report.md, keyed by model. */
	function errorCells(markdown: string): Map<string, string> {
		const costTable = markdown.slice(markdown.indexOf("## Cost"));
		const cells = new Map<string, string>();
		for (const line of costTable.split("\n").slice(4)) {
			if (!line.startsWith("| ")) break;
			const columns = line.split(" | ");
			cells.set(columns[0]?.slice(2) ?? "", columns.at(-1)?.slice(0, -2) ?? "");
		}
		return cells;
	}

	for (const [name, expected] of [
		[
			"classify-email",
			{
				"anthropic/claude-haiku-4-5": "within range",
				"anthropic/claude-sonnet-5": "within range",
			},
		],
		[
			"extract-questions",
			{
				// The shim recorded no target usage: 0 is not within range.
				"anthropic/claude-sonnet-4-6": "no recorded tokens",
				"anthropic/claude-sonnet-5": "within range",
			},
		],
	] as const)
		test(`the committed ${name} run lands every priced line with recorded tokens within the estimated range`, async () => {
			const cwd = await copyOfFrozenSuite(name);
			const { context } = await ctxIn(cwd);
			expect(await run(["report", join(cwd, "results.json")], context)).toBe(0);
			const json = ReportSchema.parse(
				JSON.parse(await readFile(join(cwd, ".forge", "report.json"), "utf8")),
			);
			for (const modelCost of json.costs) {
				const low = modelCost.estimatedLowDollars;
				const high = modelCost.estimatedHighDollars;
				const real = modelCost.realDollars;
				expect([modelCost.model, low === null, high === null]).toEqual([
					modelCost.model,
					false,
					false,
				]);
				if (modelCost.inputTokens + modelCost.outputTokens === 0) continue;
				expect({ model: modelCost.model, low, real, high }).toEqual({
					model: modelCost.model,
					low,
					real: Math.min(Math.max(real ?? -1, low ?? 0), high ?? 0),
					high,
				});
			}
			expect(
				Object.fromEntries(
					errorCells(await readFile(join(cwd, ".forge", "report.md"), "utf8")),
				),
			).toEqual(expected);
		});

	test("the report.json the forge wrote before the estimate range loads as --baseline", async () => {
		// The frozen classify-email report predates the range: its costs
		// carry no estimatedLowDollars or estimatedHighDollars.
		const cwd = await copyOfFrozenSuite("classify-email");
		const previous = join(cwd, "previous.json");
		await cp(join(cwd, ".forge", "report.json"), previous);
		expect(await readFile(previous, "utf8")).not.toContain(
			"estimatedLowDollars",
		);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["report", join(cwd, "results.json"), "--baseline", previous],
				context,
			),
		).toBe(0);
		expect(out).toContain("report: since baseline: 0 regressions, 0 fixed");
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
		const suiteFile = join(forgeDirectory, "suite.yaml");
		const seeded = `target:
  kind: python
  entry: forge_target.py
  models: [anthropic/claude-haiku-4-5] # kept
judges: [google/gemini-3.5-flash]
repeat: 2
include: [other] # kept too
`;
		await writeFile(suiteFile, seeded);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "polite-rejection", "soft-no"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario polite-rejection → soft-no; 0 case(s) renumbered",
		]);
		// Only the stamp line is new: any other rewrite (writeSuite drops the
		// comments and turns flow lists into blocks) changes this text.
		expect(await readFile(suiteFile, "utf8")).toBe(
			`forge_version: ${FORGE_VERSION}\n${seeded}`,
		);
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
			`forge_version: ${FORGE_VERSION}`,
			"target:",
			"  kind: python",
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
		const eitherForm =
			"error: move takes either --scenario <old> <new> or --case <id> --to <scenario>";
		const halfCase = "error: --case <id> and --to <scenario> go together";
		const twoIds =
			"error: --scenario takes exactly two ids: the old one and the new one";
		const lines: [string[], string][] = [
			[["move"], eitherForm],
			[
				["move", "--scenario", "a", "b", "--case", "x", "--to", "b"],
				eitherForm,
			],
			[["move", "--case", "x"], halfCase],
			[["move", "--to", "b"], halfCase],
			[["move", "--scenario", "a"], twoIds],
			[["move", "--scenario", "a", "b", "c"], twoIds],
			[
				["move", "--case", "x", "--to", "b", "c"],
				'error: unexpected argument "c"; --case takes only --to <scenario>',
			],
		];
		for (const [argv, message] of lines) {
			const { context, out } = await ctxIn(cwd);
			expect({ argv, exitCode: await run(argv, context) }).toEqual({
				argv,
				exitCode: 2,
			});
			expect({ argv, said: out.at(-1) }).toEqual({ argv, said: message });
		}
	});
});

describe("llm-tests-forge move --scenario: what a failed write says when there is no cases file, or only an empty one", () => {
	test("scenarios.yaml cannot be written and no cases file was copied: nothing else is on disk", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
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
				`error: cannot write: EACCES: permission denied, open '${scenariosFile}' (file: ${scenariosFile}); nothing else is written; run the move again`,
			);
		} finally {
			await chmod(scenariosFile, 0o644);
		}
	});

	test("suite.yaml cannot be rewritten and there is no cases file: the hand steps do not mention deleting one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
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
				`error: cannot write: EACCES: permission denied, open '${suiteFile}' (file: ${suiteFile}); already written: scenarios.yaml; change polite-rejection to soft-no in suite.include by hand`,
			);
		} finally {
			await chmod(suiteFile, 0o644);
		}
	});

	test("the empty cases file cannot be removed after scenarios.yaml and suite.yaml were rewritten: the message lists both, in the order written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDirectory, "polite-rejection", []);
		await writeSuite(forgeDirectory, {
			...SUITE,
			include: ["polite-rejection"],
		});
		// Both rewrites are in place, so they need no write to the directory;
		// removing the empty file does, and the directory refuses it.
		const casesDirectory = join(forgeDirectory, "cases");
		const sourceFile = join(casesDirectory, "polite-rejection.yaml");
		await chmod(casesDirectory, 0o555);
		try {
			const { context, out } = await ctxIn(cwd);
			expect(
				await run(
					["move", "--scenario", "polite-rejection", "soft-no"],
					context,
				),
			).toBe(1);
			expect(out.at(-1)).toBe(
				`error: cannot remove: EACCES: permission denied, unlink '${sourceFile}'; already written: scenarios.yaml, suite.yaml; delete cases/polite-rejection.yaml by hand (file: ${sourceFile})`,
			);
			expect((await readScenarios(forgeDirectory))[0]?.id).toBe("soft-no");
			expect((await readSuite(forgeDirectory)).include).toEqual(["soft-no"]);
		} finally {
			await chmod(casesDirectory, 0o755);
		}
	});

	test("a cases file whose name only sounds like the id is another file: `strasse` is not the file of `straße`", async () => {
		// The names are compared by Unicode normalisation and lower-casing,
		// which is what the filesystem folds; full case folding (ß = ss)
		// would call two different files one and refuse the rename.
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "straße",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "strasse", [
			CASE("strasse-01", "strasse"),
		]);
		const other = join(forgeDirectory, "cases", "strasse.yaml");
		await utimes(other, LONG_AGO, LONG_AGO);

		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["move", "--scenario", "straße", "soft-no"], context),
		).toBe(0);
		expect(out).toEqual([
			"move: scenario straße → soft-no; 0 case(s) renumbered",
		]);
		expect((await stat(other)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("llm-tests-forge move --case: the line about a scenario that is not approved", () => {
	async function moveInto(status: "approved" | "edited" | "pending") {
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
				status,
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection"),
			CASE("polite-rejection-02", "polite-rejection"),
		]);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(
				["move", "--case", "polite-rejection-01", "--to", "huge-signature"],
				context,
			),
		).toBe(0);
		return out;
	}

	test.each([["approved"], ["edited"]] as const)(
		"a %s scenario gets the case and no warning",
		async (status) => {
			expect(await moveInto(status)).toEqual([
				"move: polite-rejection-01 → huge-signature-01 (scenario huge-signature)",
			]);
		},
	);

	test("a pending scenario gets the case and a warning that it will not run", async () => {
		expect(await moveInto("pending")).toEqual([
			"move: polite-rejection-01 → huge-signature-01 (scenario huge-signature)",
			"move: scenario huge-signature is pending, so huge-signature-01 will not run until the scenario is approved",
		]);
	});
});

describe("review: the words and the numbers of the command line and of the write-back", () => {
	/** A forge with the feature, one `label` scenario and one case, each with the status given. */
	async function forgeOf(
		cwd: string,
		statuses: {
			feature: "pending" | "approved";
			scenario: "pending" | "approved";
			caseEntry: "pending" | "approved";
		},
	) {
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, {
			...FEATURE,
			status: statuses.feature,
		});
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: statuses.scenario,
			},
		]);
		await writeCases(forgeDirectory, "polite-rejection", [
			CASE("polite-rejection-01", "polite-rejection", {
				status: statuses.caseEntry,
			}),
		]);
		return forgeDirectory;
	}

	/** Reviews with every answer "approve" while `readOnly` cannot be written; the exit code and the last line. */
	async function reviewWithReadOnly(cwd: string, readOnly: string) {
		await chmod(readOnly, 0o444);
		try {
			const { context, out } = await ctxIn(cwd, [
				"approve",
				"approve",
				"approve",
			]);
			const exitCode = await run(["review"], context);
			return { exitCode, last: out.at(-1) };
		} finally {
			await chmod(readOnly, 0o644);
		}
	}

	test("--only names the values it takes, in order", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeOf(cwd, {
			feature: "approved",
			scenario: "approved",
			caseEntry: "pending",
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "nonsense"], context)).toBe(2);
		expect(out.at(-1)).toBe(
			'error: --only "nonsense" is not valid; choose one of: feature, scenarios, cases',
		);
	});

	test("--only with nothing pending anywhere says nothing is pending, not that a filter hid something", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeOf(cwd, {
			feature: "approved",
			scenario: "approved",
			caseEntry: "approved",
		});
		const { context, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "cases"], context)).toBe(0);
		expect(out).toEqual([
			"Next: run llm-tests-forge estimate, then emit.",
			"review: nothing pending",
		]);
	});

	test("--scenario offers that scenario itself and its cases, and counts only what is inside it as still pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "approved",
			scenario: "pending",
			caseEntry: "pending",
		});
		await writeScenarios(forgeDirectory, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
			{
				id: "elsewhere",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		const { context, out } = await ctxIn(cwd, ["approve", "approve"]);
		expect(
			await run(["review", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => [
				scenario.id,
				scenario.status,
			]),
		).toEqual([
			["polite-rejection", "approved"],
			["elsewhere", "pending"],
		]);
		expect(out.at(-1)).toBe(
			"review: 2 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});

	test("a cases file rewritten during the pass to a different size under the same modification time is not the file that was read", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "approved",
			scenario: "approved",
			caseEntry: "pending",
		});
		const casesPath = join(forgeDirectory, "cases", "polite-rejection.yaml");
		await utimes(casesPath, LONG_AGO, LONG_AGO);
		const outsideContent =
			"# someone else, with a longer comment than before\n[]\n";
		const out: string[] = [];
		const context = createContext({
			cwd,
			drafter: MODEL,
			stdin: async () => {
				await writeFile(casesPath, outsideContent, "utf8");
				await utimes(casesPath, LONG_AGO, LONG_AGO);
				return "approve";
			},
		});
		context.stdout = (line) => out.push(line);
		expect(await run(["review", "--only", "cases"], context)).toBe(0);
		expect(out).toContain(
			"review: cases/polite-rejection.yaml changed on disk during the pass; its decisions were not written",
		);
		expect(await readFile(casesPath, "utf8")).toBe(outsideContent);
	});

	test("feature.yaml cannot be written: nothing is written, and the scenarios and cases decided after it are named as not written", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "pending",
			scenario: "pending",
			caseEntry: "pending",
		});
		const target = join(forgeDirectory, "feature.yaml");
		const { exitCode, last } = await reviewWithReadOnly(cwd, target);
		expect(exitCode).toBe(1);
		expect(last).toBe(
			`error: cannot write: EACCES: permission denied, open '${target}' (file: ${target}); the write-back stopped there: already written: nothing; not written: feature.yaml, scenarios.yaml, cases/polite-rejection.yaml`,
		);
	});

	test("feature.yaml cannot be written and no scenario was decided: scenarios.yaml is not named", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "pending",
			scenario: "approved",
			caseEntry: "approved",
		});
		const target = join(forgeDirectory, "feature.yaml");
		const { exitCode, last } = await reviewWithReadOnly(cwd, target);
		expect(exitCode).toBe(1);
		expect(last).toBe(
			`error: cannot write: EACCES: permission denied, open '${target}' (file: ${target}); the write-back stopped there: already written: nothing; not written: feature.yaml`,
		);
	});

	test("scenarios.yaml cannot be written after feature.yaml was: it is named once, with the file that did land", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "pending",
			scenario: "pending",
			caseEntry: "pending",
		});
		const target = join(forgeDirectory, "scenarios.yaml");
		const { exitCode, last } = await reviewWithReadOnly(cwd, target);
		expect(exitCode).toBe(1);
		expect(last).toBe(
			`error: cannot write: EACCES: permission denied, open '${target}' (file: ${target}); the write-back stopped there: already written: feature.yaml; not written: scenarios.yaml, cases/polite-rejection.yaml`,
		);
	});

	test("a cases file cannot be written after two others landed: the written ones are listed in order", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeOf(cwd, {
			feature: "pending",
			scenario: "pending",
			caseEntry: "pending",
		});
		const target = join(forgeDirectory, "cases", "polite-rejection.yaml");
		const { exitCode, last } = await reviewWithReadOnly(cwd, target);
		expect(exitCode).toBe(1);
		expect(last).toBe(
			`error: cannot write: EACCES: permission denied, open '${target}' (file: ${target}); the write-back stopped there: already written: feature.yaml, scenarios.yaml; not written: cases/polite-rejection.yaml`,
		);
	});

	test("a failure that is not a failed write is passed on as it is, not described as a stopped write-back", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeOf(cwd, {
			feature: "approved",
			scenario: "approved",
			caseEntry: "pending",
		});
		const { context, out } = await ctxIn(cwd, ["approve"]);
		const print = context.stdout;
		context.stdout = (line) => {
			// The summary comes after every write: nothing is mid-write.
			if (line.startsWith("review: 1 approved"))
				throw new ForgeError("the terminal went away");
			print(line);
		};
		expect(await run(["review"], context)).toBe(1);
		expect(out.at(-1)).toBe("error: the terminal went away");
	});

	/** Runs `body` with `$EDITOR` pointing at `path`. */
	async function withEditor<Result>(
		path: string,
		body: () => Promise<Result>,
	): Promise<Result> {
		const original = process.env.EDITOR;
		process.env.EDITOR = path;
		try {
			return await body();
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}
	}

	test("a scenario's oracle change is judged against that scenario's own earlier oracle, whichever scenarios were decided before it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "rubric",
				description: "d",
				status: "pending",
			},
			{
				id: "beta",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "beta", [CASE("beta-01", "beta")]);
		const editor = await editorReplacing(
			cwd,
			"oracle: label",
			"oracle: rubric",
		);
		const { context, out } = await ctxIn(cwd, ["approve", "edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review"], context)).toBe(0);
		});
		expect(out).toContain(
			"review: scenario beta changed oracle label → rubric; 1 case(s) re-opened — edit each to give it an expected the new oracle accepts",
		);
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => [
				scenario.id,
				scenario.oracle,
				scenario.status,
			]),
		).toEqual([
			["alpha", "rubric", "approved"],
			["beta", "rubric", "edited"],
		]);
		expect((await readCases(forgeDirectory, "beta"))[0]?.status).toBe(
			"pending",
		);
	});

	test("a scenario decided earlier in the pass does not stand in for the others when a later case is checked against its own scenario's oracle", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
			{
				id: "beta",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "beta", [
			CASE("beta-01", "beta", { status: "pending" }),
		]);
		const { context, out } = await ctxIn(cwd, ["approve", "approve"]);
		expect(await run(["review"], context)).toBe(0);
		expect(out.filter((line) => line.includes("cannot apply"))).toEqual([]);
		expect((await readCases(forgeDirectory, "beta"))[0]?.status).toBe(
			"approved",
		);
		expect(out.at(-1)).toBe(
			"review: 2 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});

	test("renaming a scenario in review is refused with the move that does it, even onto a sibling's id, and the item is asked again", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
			{
				id: "beta",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		const editor = await editorReplacing(cwd, "id: alpha", "id: beta");
		const { context, out } = await ctxIn(cwd, ["edit", "skip", "skip"]);
		await withEditor(editor, async () => {
			expect(await run(["review"], context)).toBe(0);
		});
		expect(out).toContain(
			'cannot apply: a scenario\'s id cannot be changed in review (from "alpha" to "beta"): it names .forge/cases/<id>.yaml; run `llm-tests-forge move --scenario alpha beta` (id: alpha)',
		);
		expect(
			(await readScenarios(forgeDirectory)).map((scenario) => scenario.id),
		).toEqual(["alpha", "beta"]);
	});
});

describe("review: what the person sees when the terminal paints, and when a scenario is edited without changing its oracle", () => {
	const ESCAPE = "\x1b[";

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

	/** Runs `body` as a terminal that paints: stdout a TTY, NO_COLOR unset. */
	async function onPaintingTerminal<T>(body: () => Promise<T>): Promise<T> {
		const originalTty = process.stdout.isTTY;
		const originalNoColor = process.env.NO_COLOR;
		process.stdout.isTTY = true;
		delete process.env.NO_COLOR;
		try {
			return await body();
		} finally {
			process.stdout.isTTY = originalTty;
			if (originalNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = originalNoColor;
		}
	}

	test("a refusal is painted as an error and the item shown above it is not", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
			{
				id: "beta",
				kind: "edge",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		const editor = await editorReplacing(cwd, "id: alpha", "id: beta");
		const { context, out } = await ctxIn(cwd, ["edit", "skip"]);
		await onPaintingTerminal(() =>
			withEditor(editor, async () => {
				expect(await run(["review"], context)).toBe(0);
			}),
		);
		const refusal =
			'cannot apply: a scenario\'s id cannot be changed in review (from "alpha" to "beta"): it names .forge/cases/<id>.yaml; run `llm-tests-forge move --scenario alpha beta` (id: alpha)';
		expect(out).toContain(`${ESCAPE}31m${refusal}${ESCAPE}39m`);
		const header = out.find((line) => line.includes("scenario"));
		expect(header?.startsWith(`${ESCAPE}1m--- `)).toBe(true);
		expect(header).not.toContain(`${ESCAPE}31m`);
		expect(out.filter((line) => line.includes("cannot apply"))).toHaveLength(1);
	});

	test("a failure that is not a write is shown as it is, not as a write-back that stopped", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDirectory, "alpha", [
			CASE("alpha-01", "alpha", { status: "pending" }),
		]);
		const { context, out } = await ctxIn(cwd, ["skip"]);
		const printed = context.stdout;
		// Nothing is decided, so nothing is written; the only thing left that
		// can fail is the summary line itself.
		context.stdout = (line) => {
			if (line.startsWith("review: 0 approved"))
				throw new ForgeError("the summary could not be printed");
			printed(line);
		};
		expect(await run(["review"], context)).toBe(1);
		expect(out.at(-1)).toBe("error: the summary could not be printed");
	});

	test("editing a scenario without changing its oracle re-opens nothing and leaves its cases file alone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeFeature(forgeDirectory, FEATURE);
		await writeScenarios(forgeDirectory, [
			{
				id: "alpha",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDirectory, "alpha", [
			CASE("alpha-01", "alpha", { status: "approved" }),
		]);
		const casesFile = join(forgeDirectory, "cases", "alpha.yaml");
		const before = await readFile(casesFile, "utf8");
		await utimes(casesFile, LONG_AGO, LONG_AGO);
		const editor = await editorReplacing(
			cwd,
			"description: d",
			"description: reworded",
		);
		const { context, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review"], context)).toBe(0);
		});
		expect((await readScenarios(forgeDirectory))[0]?.description).toBe(
			"reworded",
		);
		expect(out.filter((line) => line.includes("changed oracle"))).toEqual([]);
		expect(await readFile(casesFile, "utf8")).toBe(before);
		expect((await stat(casesFile)).mtime).toEqual(LONG_AGO);
		expect(
			(await readCases(forgeDirectory, "alpha")).map((entry) => entry.status),
		).toEqual(["approved"]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});
});

describe("main(): the suite and the project", () => {
	test("inside a project, a verb run where there is no .forge lists the registered suites and exits 2", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const lines: string[] = [];
		expect(
			await main(["estimate"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(2);
		expect(lines.join("\n")).toContain("registered suites in");
		expect(lines.join("\n")).toContain("evals/a");
		expect(lines.join("\n")).toContain("--suite <path>");
	});

	test("--suite is taken out of the arguments before the verb parses them, in both spellings", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		await cp(
			fixturePath("extract-questions/.forge"),
			join(root, "evals", "a", ".forge"),
			{ recursive: true },
		);
		await cp(
			fixturePath("extract-questions/prompt.txt"),
			join(root, "evals", "a", "prompt.txt"),
		);
		for (const argv of [
			["estimate", "--suite", "evals/a"],
			["estimate", "--suite=evals/a"],
		]) {
			const lines: string[] = [];
			expect(
				await main(argv, {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(0);
			expect(lines.join("\n")).toContain("total");
		}
	});

	test("--suite with no path, and --suite naming a suite that is not registered, are reported as errors", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const missingPath: string[] = [];
		expect(
			await main(["estimate", "--suite"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => missingPath.push(line),
			}),
		).toBe(2);
		expect(missingPath).toEqual([
			"error: --suite needs a path: --suite <path>",
		]);
		const unregistered: string[] = [];
		expect(
			await main(["estimate", "--suite", "evals/zzz"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => unregistered.push(line),
			}),
		).toBe(2);
		expect(unregistered.join("\n")).toContain(
			'error: suite "evals/zzz" is not registered in',
		);
		expect(unregistered.join("\n")).toContain(
			"registered: evals/a. If it exists, add its path to suites: in forge.yaml (for example `suites: [evals/zzz]`, or, when suites is already a block list, add a `- evals/zzz` line with the same indentation as the existing entries)",
		);
	});

	test("a forge.yaml that does not parse is a ForgeError naming the file, exit 1", async () => {
		const root = await projectWith("version: 2\n");
		const lines: string[] = [];
		expect(
			await main(["estimate"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(1);
		expect(lines.join("\n")).toContain("forge.yaml");
	});

	test("a programming error is not flattened into an error line", async () => {
		const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
		await expect(
			main(["describe"], {
				cwd: outside,
				env: { FORGE_DRAFTER: MODEL },
				stdin: async () => {
					throw new TypeError("a bug, not a message");
				},
				stdout: () => {},
			}),
		).rejects.toBeInstanceOf(TypeError);
	});

	test("a verb run outside any project is not refused by the suite guard", async () => {
		const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
		const lines: string[] = [];
		await main(["estimate"], {
			cwd: outside,
			env: {},
			stdin: async () => "",
			stdout: (line) => lines.push(line),
		});
		expect(lines.join("\n")).not.toContain("no suite here");
		expect(lines.join("\n")).toContain("feature.yaml");
	});

	test("inside a project with no .forge, a word that is not a verb gets the usage, not the suite guard", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		for (const word of ["frobnicate", "toString"]) {
			const lines: string[] = [];
			expect(
				await main([word], {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(2);
			expect(lines.join("\n")).toContain("usage: llm-tests-forge");
			expect(lines.join("\n")).not.toContain("no suite here");
		}
	});

	test("inside a project with no .forge, no verb at all gets the usage, not the suite guard", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const lines: string[] = [];
		expect(
			await main([], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(2);
		expect(lines.join("\n")).toContain("usage: llm-tests-forge");
		expect(lines.join("\n")).not.toContain("no suite here");
	});

	test("help and version are answered even when forge.yaml is malformed, in a project with no .forge", async () => {
		const root = await projectWith("version: 2\n");
		for (const [word, expected] of [
			["--help", "usage: llm-tests-forge"],
			["help", "usage: llm-tests-forge"],
			["--version", FORGE_VERSION],
			["-V", FORGE_VERSION],
			["version", FORGE_VERSION],
		] as const) {
			const lines: string[] = [];
			expect(
				await main([word], {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(0);
			expect(lines.join("\n")).toContain(expected);
		}
	});

	test("an information verb first is answered even with a dangling --suite after it", async () => {
		const root = await projectWith("version: 2\n");
		const lines: string[] = [];
		expect(
			await main(["version", "--suite"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(0);
		expect(lines).toEqual([FORGE_VERSION]);
	});

	test("a --suite after the -- belongs to the verb, not to the suite resolution", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: []\n",
		);
		const lines: string[] = [];
		expect(
			await main(["status", "--", "--suite", "evals/a"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(2);
		expect(lines[0]).toStartWith(
			'error: status takes no argument, got "--suite evals/a"',
		);
	});

	test("a leading -- is not a help flag's boundary: what follows it is the verb's own", async () => {
		const { context, out } = await ctxIn(
			await mkdtemp(join(tmpdir(), "forge-cli-")),
		);
		expect(await run(["--", "--help"], context)).toBe(2);
		expect(out.join("\n")).toContain("usage: llm-tests-forge");
	});

	test("help, version and guide after --suite are still answered when forge.yaml is malformed", async () => {
		const root = await projectWith("version: 2\n");
		for (const [argv, expected] of [
			[["--suite", "evals/x", "--help"], "usage: llm-tests-forge"],
			[["--suite=evals/x", "help"], "usage: llm-tests-forge"],
			[["--suite", "evals/x", "version"], FORGE_VERSION],
			[["--suite", "evals/x", "guide"], "approving is the person's job"],
		] as const) {
			const lines: string[] = [];
			expect(
				await main([...argv], {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(0);
			expect(lines.join("\n")).toContain(expected);
		}
	});

	test("--help or -h anywhere before -- prints the usage and exits 0 with a malformed forge.yaml, and a positional after -- is left alone", async () => {
		const root = await projectWith("version: 2\n");
		for (const argv of [
			["status", "--help"],
			["emit", "-h"],
			["--suite", "x", "--help"],
			["describe", "some text", "-h"],
		]) {
			const lines: string[] = [];
			expect(
				await main(argv, {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(0);
			expect(lines).toEqual([USAGE]);
		}
	});

	test("cases --drafter -h prints the usage and exits 0: -h is not taken as the drafter's value", async () => {
		const root = await projectWith("version: 2\n");
		const lines: string[] = [];
		expect(
			await main(["cases", "--drafter", "-h"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(0);
		expect(lines).toEqual([USAGE]);
	});

	/** A config directory whose anthropic/api.env is half garbage around one key. */
	async function configDirectoryWithMalformedKeyFile(): Promise<string> {
		const configDirectory = await mkdtemp(join(tmpdir(), "forge-keys-"));
		await mkdir(join(configDirectory, "anthropic"), { recursive: true });
		await writeFile(
			join(configDirectory, "anthropic", "api.env"),
			"this line has no equals sign\n=no-name\nexport ANTHROPIC_API_KEY=from-file\n\u0000\u0001 binary junk\n",
		);
		return configDirectory;
	}

	test("--help is answered before the provider keys are read: a malformed api.env is never loaded into the environment", async () => {
		const configDirectory = await configDirectoryWithMalformedKeyFile();
		const environment: Record<string, string | undefined> = {};
		const processEnvironmentBefore = { ...process.env };
		const lines: string[] = [];
		expect(
			await main(["--help"], {
				cwd: configDirectory,
				env: environment,
				configDirectory,
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(0);
		expect(lines).toEqual([USAGE]);
		expect(environment).toEqual({});
		expect(process.env).toEqual(processEnvironmentBefore);
	});

	test("the provider keys are read from the injected config directory only on the way to a model: status and a usage error read none", async () => {
		const configDirectory = await configDirectoryWithMalformedKeyFile();
		for (const [argv, code] of [
			[["status"], 0],
			[["status", "--version"], 2],
			[["status", "extra"], 2],
		] as const) {
			const environment: Record<string, string | undefined> = {};
			const lines: string[] = [];
			const outcome = await main([...argv], {
				cwd: configDirectory,
				env: environment,
				configDirectory,
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			});
			expect({ argv, outcome, environment }).toEqual({
				argv,
				outcome: code,
				environment: {},
			});
		}
		// describe reads them when it reaches its model. The key the shell
		// exports is taken out for the call, so the model is refused for a
		// missing key. And should a key ever reach the provider anyway (a
		// resolver reading the loaded keys, say), its base URL is a closed
		// local port, so nothing can go over the network either way.
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: []\n",
		);
		const environment: Record<string, string | undefined> = {};
		const exported = process.env.ANTHROPIC_API_KEY;
		const exportedBaseUrl = process.env.ANTHROPIC_BASE_URL;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
		const lines: string[] = [];
		try {
			const outcome = await main(
				["describe", "--drafter", "anthropic/claude-x", "classifies emails"],
				{
					cwd: root,
					env: environment,
					configDirectory,
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				},
			);
			expect(outcome).toBe(1);
		} finally {
			if (exported !== undefined) process.env.ANTHROPIC_API_KEY = exported;
			if (exportedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
			else process.env.ANTHROPIC_BASE_URL = exportedBaseUrl;
		}
		expect(lines).toEqual([
			'error: ANTHROPIC_API_KEY is not set; needed for "anthropic/claude-x"',
		]);
		expect(environment).toEqual({ ANTHROPIC_API_KEY: "from-file" });
	});

	test("tests never read the real ~/.config: a main() call left to the test defaults loads no key", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const environment: Record<string, string | undefined> = {};
		await main(["status"], {
			cwd: root,
			env: environment,
			stdin: async () => "",
			stdout: () => {},
		});
		// Key names only: a failure here must not print a real key.
		expect(Object.keys(environment)).toEqual([]);
	});

	test("the test default config directory is an empty directory under the run's TMPDIR, never under the home directory", async () => {
		const temporaryRoot = await realpath(tmpdir());
		const resolved = await realpath(EMPTY_CONFIG_DIRECTORY);
		expect(resolved.startsWith(`${temporaryRoot}/`)).toBe(true);
		expect(resolved.startsWith(`${await realpath(homedir())}/.config`)).toBe(
			false,
		);
		expect(await readdir(resolved)).toEqual([]);
	});

	test("help, version and guide are answered before any key file is opened", async () => {
		// Every provider's api.env is a FIFO: opening one for reading blocks
		// until a writer comes, so a verb that reads the key files hangs.
		// Afterwards, a non-blocking open for writing succeeds only when a
		// reader is waiting on the FIFO — that is, only if it was opened.
		const configDirectory = await mkdtemp(join(tmpdir(), "forge-keys-"));
		const fifos: string[] = [];
		for (const provider of ["anthropic", "google", "openai"]) {
			await mkdir(join(configDirectory, provider));
			const fifo = join(configDirectory, provider, "api.env");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			fifos.push(fifo);
		}
		/** The FIFOs some reader is blocked on, unblocking each one found. */
		const openedFifos = async (): Promise<string[]> => {
			const opened: string[] = [];
			for (const fifo of fifos) {
				const handle = await open(
					fifo,
					constants.O_WRONLY | constants.O_NONBLOCK,
				).catch(() => null);
				if (handle === null) continue;
				opened.push(fifo);
				await handle.write("\n");
				await handle.close();
			}
			return opened;
		};
		for (const [argv, code] of [
			[["help"], 0],
			[["version"], 0],
			[["--version"], 0],
			[["-V"], 0],
			[["guide"], 0],
			[["--suite", "evals/x", "version"], 0],
			// No verb the CLI knows: answered with the usage, exit 2, and no
			// key file either.
			[["--drafter", "x", "version"], 2],
			[["nonsense"], 2],
			[[], 2],
			// A usage error is answered before any key file is opened too.
			[["status", "--version"], 2],
		] as const) {
			const answered = main([...argv], {
				cwd: configDirectory,
				env: {},
				configDirectory,
				stdin: async () => "",
				stdout: () => {},
			});
			const outcome = await Promise.race([
				answered,
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("still waiting"), 1000),
				),
			]);
			const opened = await openedFifos();
			expect({ argv, outcome, opened }).toEqual({
				argv,
				outcome: code,
				opened: [],
			});
			await answered;
		}
	}, 30_000);

	test("describe -- --help and describe -- -h run describe with the flag as the text, in a valid project", async () => {
		for (const word of ["--help", "-h"]) {
			const root = await projectWith(
				"version: 1\nlanguage: python\nsuites: []\n",
			);
			const lines: string[] = [];
			expect(
				await main(["describe", "--", word], {
					cwd: root,
					env: { FORGE_DRAFTER: MODEL },
					// The text is a positional: stdin is only read when there is none.
					stdin: async () => {
						throw new Error("describe read stdin instead of taking the text");
					},
					stdout: (line) => lines.push(line),
				}),
			).toBe(0);
			expect(lines).not.toContain(USAGE);
			expect(lines.join("\n")).toContain(
				'describe: feature "classify-email" written as pending',
			);
			expect(
				(await readFile(join(root, ".forge", "feature.yaml"), "utf8")).length,
			).toBeGreaterThan(0);
		}
	});

	test("the usage and the guide say that a describe text of -h or --help goes after --", async () => {
		expect(USAGE).toContain("a text that is -h or --help goes after --");
		expect(
			await readFile(join(REPOSITORY, "templates/guide.md"), "utf8"),
		).toContain("so a text that is one of them goes after `--`");
	});

	test("--version stays a verb-position flag: after another verb it is an unknown option, exit 2, not the version", async () => {
		const lines: string[] = [];
		expect(
			await main(["status", "--version"], {
				cwd: await mkdtemp(join(tmpdir(), "forge-version-")),
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(2);
		expect(lines.join("\n")).toContain("error: Unknown option '--version'");
		expect(lines).not.toContain(FORGE_VERSION);
	});

	test("guide is answered even when forge.yaml is malformed, and does not stamp or warn", async () => {
		const root = await projectWith("version: 2\n");
		const lines: string[] = [];
		expect(
			await main(["guide"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(0);
		expect(lines.join("\n")).toContain("approving is the person's job");
	});

	test("guide exits 0 and opens with the rule that approving is the person's job", async () => {
		const { context, out } = await ctxIn(
			await mkdtemp(join(tmpdir(), "forge-guide-")),
		);
		expect(await run(["guide"], context)).toBe(0);
		const guide = out.join("\n");
		const blocks = guide.split(/\n\s*\n/);
		const firstHeading = blocks.find((block) => block.startsWith("## "));
		expect(firstHeading).toBe("## The rule");
		const sectionStart = blocks.indexOf("## The rule");
		expect(blocks[sectionStart + 1]).toContain("approving is the person's job");
	});

	test("the guide defines the words the review screen uses", async () => {
		const { context, out } = await ctxIn(
			await mkdtemp(join(tmpdir(), "forge-guide-")),
		);
		expect(await run(["guide"], context)).toBe(0);
		const guide = out.join("\n");
		for (const definition of [
			"**pending**: waiting for your decision",
			"**expected**: the answer the drafter proposes for a case, which you confirm or correct",
			"**oracle**: how a case is checked",
			"**scenario**: one situation that a group of cases covers",
			"**review**: the pass in which you decide on each pending item",
		])
			expect(guide).toContain(definition);
	});

	test("the guide names every verb in USAGE, so a new verb without a guide entry fails", async () => {
		const { context, out } = await ctxIn(
			await mkdtemp(join(tmpdir(), "forge-guide-")),
		);
		await run(["guide"], context);
		const guide = out.join("\n");
		const verbs = USAGE.split("\n")
			.map((line) => /^ {2}([a-z]+)\b/.exec(line)?.[1])
			.filter((verb): verb is string => verb !== undefined);
		expect(verbs).toContain("status");
		expect(verbs).toContain("guide");
		expect([...verbs].filter((verb) => verb !== "help").sort()).toEqual(
			Object.keys(COMMANDS).sort(),
		);
		const everyVerb = guide.split("## Every verb")[1]?.split("\n## ")[0] ?? "";
		for (const verb of [...verbs, "version"])
			expect(everyVerb).toContain(`- \`llm-tests-forge ${verb}\`:`);
	});

	test("guide prints the manual first and neither warns about nor stamps an old suite", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-guide-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = join(forgeDirectory, "suite.yaml");
		await writeFile(
			path,
			`forge_version: 0.0.1\n${await readFile(path, "utf8")}`,
		);
		const before = await readFile(path, "utf8");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["guide"], context)).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]?.startsWith("# llm-tests-forge")).toBe(true);
		expect(await readFile(path, "utf8")).toBe(before);
	});

	test("the skill and the marketplace file have the shape the plugin needs", async () => {
		const repositoryRoot = join(import.meta.dir, "..", "..");
		const skill = await readFile(
			join(repositoryRoot, "plugin/skills/llm-tests-forge/SKILL.md"),
			"utf8",
		);
		const frontmatter = parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "");
		expect(frontmatter.name).toBe("llm-tests-forge");
		expect(frontmatter.description).toContain("create LLM tests");
		expect(frontmatter.description).toContain("cria testes");
		const marketplace = JSON.parse(
			await readFile(
				join(repositoryRoot, ".claude-plugin/marketplace.json"),
				"utf8",
			),
		);
		expect(marketplace.plugins).toHaveLength(1);
		expect(marketplace.plugins[0].source).toBe("./plugin");
		const manifest = JSON.parse(
			await readFile(
				join(repositoryRoot, "plugin/.claude-plugin/plugin.json"),
				"utf8",
			),
		);
		expect(manifest.version).toBe(FORGE_VERSION);
	});

	test("--suite is refused when it has no usable path, is repeated, or names a backslash path; what follows -- is left alone", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const attempts: [string[], number, string][] = [
			[
				["estimate", "--suite="],
				2,
				"error: --suite needs a path: --suite <path>",
			],
			[
				["estimate", "--suite", "--drafter", "x"],
				2,
				"error: --suite needs a path: --suite <path>",
			],
			[
				["estimate", "--suite", "evals/a", "--suite=evals/a"],
				2,
				"error: --suite was given more than once; pass one path",
			],
			[
				["estimate", "--suite", "evals\\a"],
				2,
				'error: suite "evals\\a" uses a backslash; write paths with forward slashes',
			],
		];
		for (const [argv, exitCode, expected] of attempts) {
			const lines: string[] = [];
			expect(
				await main(argv, {
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => lines.push(line),
				}),
			).toBe(exitCode);
			expect(lines).toEqual([expected]);
		}
		const afterDashes: string[] = [];
		await main(["describe", "--", "--suite", "evals/a"], {
			cwd: root,
			env: { FORGE_DRAFTER: MODEL },
			stdin: async () => "",
			stdout: (line) => afterDashes.push(line),
		});
		expect(afterDashes.join("\n")).not.toContain("--suite needs");
		expect(afterDashes.join("\n")).not.toContain("not registered");
	});

	test("describe at the project root registers it as '.', once, and every verb still works afterwards", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: []\n",
		);
		const first: string[] = [];
		expect(
			await main(["describe", "classify hiring emails", "--drafter", MODEL], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => first.push(line),
			}),
		).toBe(0);
		expect(
			parse(await readFile(join(root, "forge.yaml"), "utf8")).suites,
		).toEqual(["."]);
		expect(first.join("\n")).toContain(
			`describe: registered . in ${join(root, "forge.yaml")}`,
		);
		const project = await readProject(root);
		expect(project.problems).toEqual([]);
		expect(project.suites.map((suite) => suite.directory)).toEqual([root]);
		const estimate: string[] = [];
		expect(
			await main(["estimate"], {
				cwd: root,
				env: {},
				stdin: async () => "",
				stdout: (line) => estimate.push(line),
			}),
		).toBe(1);
		expect(estimate.join("\n")).not.toContain("forge.yaml");
		const second: string[] = [];
		expect(
			await main(
				["describe", "classify hiring emails", "--force", "--drafter", MODEL],
				{
					cwd: root,
					env: {},
					stdin: async () => "",
					stdout: (line) => second.push(line),
				},
			),
		).toBe(0);
		expect(second.join("\n")).not.toContain("registered");
		expect(
			parse(await readFile(join(root, "forge.yaml"), "utf8")).suites,
		).toEqual(["."]);
	});

	test("describe keeps an absolute --prompt-file absolute and rebases './prompt.txt' from inside the suite", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const suiteDirectory = join(root, "evals", "a");
		await mkdir(suiteDirectory, { recursive: true });
		await writeFile(join(suiteDirectory, "prompt.txt"), "Classify the email.");
		const outsideFile = join(root, "elsewhere.txt");
		await writeFile(outsideFile, "Classify.");
		const spellings: [string, string][] = [
			[outsideFile, outsideFile],
			["./prompt.txt", "prompt.txt"],
		];
		for (const [given, stored] of spellings) {
			expect(
				await main(
					[
						"describe",
						"classify hiring emails",
						"--force",
						"--prompt-file",
						given,
						"--drafter",
						MODEL,
					],
					{
						cwd: suiteDirectory,
						env: {},
						stdin: async () => "",
						stdout: () => {},
					},
				),
			).toBe(0);
			expect(
				(await readFeature(join(suiteDirectory, ".forge"))).prompt_file,
			).toBe(stored);
		}
	});

	test("the drafter falls back to defaults.drafter in forge.yaml, after --drafter and FORGE_DRAFTER", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\ndefaults:\n  drafter: fake/from-project\n",
		);
		const project = await readProject(root);
		expect(
			createContext({ cwd: root, project, env: {}, stdin: async () => "" })
				.drafter,
		).toBe("fake/from-project");
		expect(
			createContext({
				cwd: root,
				project,
				env: { FORGE_DRAFTER: "fake/env" },
				stdin: async () => "",
			}).drafter,
		).toBe("fake/env");
		// An empty FORGE_DRAFTER is unset, so defaults.drafter still applies.
		expect(
			createContext({
				cwd: root,
				project,
				env: { FORGE_DRAFTER: "" },
				stdin: async () => "",
			}).drafter,
		).toBe("fake/from-project");
		expect(
			createContext({
				cwd: root,
				project,
				drafter: "fake/flag",
				env: { FORGE_DRAFTER: "fake/env" },
				stdin: async () => "",
			}).drafter,
		).toBe("fake/flag");
	});

	test("describe in an unregistered directory of a project registers it, keeps forge.yaml's comments, and writes a starting suite.yaml from the defaults", async () => {
		const root = await projectWith(
			"# keep me\nversion: 1\nlanguage: python\nsuites: []\ndefaults:\n  target_models: [anthropic/claude-haiku-4-5]\n  judges: [google/gemini-3.5-flash]\n",
		);
		const suiteDirectory = join(root, "evals", "new");
		await mkdir(suiteDirectory, { recursive: true });
		const lines: string[] = [];
		const exitCode = await main(
			["describe", "classify hiring emails", "--drafter", MODEL],
			{
				cwd: suiteDirectory,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			},
		);
		expect(exitCode).toBe(0);
		const projectText = await readFile(join(root, "forge.yaml"), "utf8");
		expect(projectText).toContain("# keep me");
		expect(parse(projectText).suites).toEqual(["evals/new"]);
		expect(lines.join("\n")).toContain(
			`describe: registered evals/new in ${join(root, "forge.yaml")}`,
		);
		expect(lines.join("\n")).toContain("from forge.yaml's defaults");
		const suite = await readSuite(join(suiteDirectory, ".forge"));
		expect(suite.target).toEqual({
			kind: "python",
			entry: "forge_target.py",
			models: ["anthropic/claude-haiku-4-5"],
		});
		expect(suite.judges).toEqual(["google/gemini-3.5-flash"]);
		expect(suite.repeat).toBe(1);
		expect(suite.include).toEqual([]);
	});

	test("describe leaves an existing suite.yaml and an already registered suite alone", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/new]\ndefaults:\n  target_models: [m/x]\n  judges: [m/y]\n",
		);
		const suiteDirectory = join(root, "evals", "new");
		await mkdir(join(suiteDirectory, ".forge"), { recursive: true });
		const existing = "target:\n  kind: ruby\n  models: [m/z]\njudges: [m/j]\n";
		await writeFile(join(suiteDirectory, ".forge", "suite.yaml"), existing);
		const lines: string[] = [];
		expect(
			await main(["describe", "classify hiring emails", "--drafter", MODEL], {
				cwd: suiteDirectory,
				env: {},
				stdin: async () => "",
				stdout: (line) => lines.push(line),
			}),
		).toBe(0);
		expect(
			await readFile(join(suiteDirectory, ".forge", "suite.yaml"), "utf8"),
		).toBe(`forge_version: ${FORGE_VERSION}\n${existing}`);
		expect(lines.join("\n")).not.toContain("registered evals/new");
		expect(lines.join("\n")).not.toContain("from forge.yaml's defaults");
	});

	test("describe writes no starting suite.yaml when a default is missing or the language is other, and still registers the suite", async () => {
		for (const projectText of [
			"version: 1\nlanguage: python\ndefaults:\n  judges: [google/gemini-3.5-flash]\n",
			"version: 1\nlanguage: python\ndefaults:\n  target_models: [m/x]\n",
			"version: 1\nlanguage: other\ndefaults:\n  target_models: [m/x]\n  judges: [m/y]\n",
		]) {
			const root = await projectWith(projectText);
			const suiteDirectory = join(root, "evals", "new");
			await mkdir(suiteDirectory, { recursive: true });
			expect(
				await main(["describe", "classify hiring emails", "--drafter", MODEL], {
					cwd: suiteDirectory,
					env: {},
					stdin: async () => "",
					stdout: () => {},
				}),
			).toBe(0);
			expect(
				await Bun.file(join(suiteDirectory, ".forge", "suite.yaml")).exists(),
			).toBe(false);
			expect(
				parse(await readFile(join(root, "forge.yaml"), "utf8")).suites,
			).toEqual(["evals/new"]);
		}
	});

	test("describe --suite evals/a --prompt-file prompts/p.txt from the project root stores the path that resolves from evals/a to the same file", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		await mkdir(join(root, "evals", "a"), { recursive: true });
		await mkdir(join(root, "prompts"), { recursive: true });
		await writeFile(join(root, "prompts", "p.txt"), "Classify the email.");
		expect(
			await main(
				[
					"describe",
					"classify hiring emails",
					"--suite",
					"evals/a",
					"--prompt-file",
					"prompts/p.txt",
					"--drafter",
					MODEL,
				],
				{ cwd: root, env: {}, stdin: async () => "", stdout: () => {} },
			),
		).toBe(0);
		const feature = await readFeature(join(root, "evals", "a", ".forge"));
		expect(feature.prompt_file).toBe(join("..", "..", "prompts", "p.txt"));
		const stored = feature.prompt_file ?? "";
		expect(resolve(root, "evals", "a", stored)).toBe(
			join(root, "prompts", "p.txt"),
		);
	});
});

describe("the version stamp and the version warning", () => {
	const OLDER_WARNING = `warning: this suite was written by llm-tests-forge 0.0.1; installed is ${FORGE_VERSION}`;

	async function stampWith(forgeDirectory: string, stamp: string | undefined) {
		const path = join(forgeDirectory, "suite.yaml");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			stamp === undefined ? text : `forge_version: ${stamp}\n${text}`,
		);
		return path;
	}

	test("emit on a suite stamped by an older version warns first, then leaves forge_version at the installed one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = await stampWith(forgeDirectory, "0.0.1");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out[0]).toBe(OLDER_WARNING);
		expect(await readFile(path, "utf8")).toContain(
			`forge_version: ${FORGE_VERSION}`,
		);
		expect(await readFile(path, "utf8")).not.toContain("0.0.1");
	});
	test("estimate warns and does not change suite.yaml", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = await stampWith(forgeDirectory, "0.0.1");
		const before = await readFile(path, "utf8");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["estimate"], context)).toBe(0);
		expect(out[0]).toBe(OLDER_WARNING);
		expect(await readFile(path, "utf8")).toBe(before);
	});
	test("a suite stamped by a newer version says to upgrade and keeps its stamp after emit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = await stampWith(forgeDirectory, "999.0.0");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out[0]).toBe(
			`warning: this suite was written by llm-tests-forge 999.0.0, newer than the installed ${FORGE_VERSION}; upgrade llm-tests-forge before changing it`,
		);
		expect(await readFile(path, "utf8")).toContain("forge_version: 999.0.0");
	});
	test("a suite with no stamp gets no warning, and a writing verb stamps it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out.some((line) => line.startsWith("warning:"))).toBe(false);
		expect((await readSuite(forgeDirectory)).forge_version).toBe(FORGE_VERSION);
	});
	test("an empty forge_version gets no warning, and a writing verb stamps it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		await stampWith(forgeDirectory, '""');
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		expect(out.some((line) => line.startsWith("warning:"))).toBe(false);
		expect((await readSuite(forgeDirectory)).forge_version).toBe(FORGE_VERSION);
	});
	test("the warning's read swallows a ForgeError: the verb reports it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const { context, out } = await ctxIn(cwd);
		context.readSuiteIfPresent = async () => {
			throw new ForgeError("cannot read suite", { file: "suite.yaml" });
		};
		expect(await run(["estimate"], context)).toBe(0);
		expect(out.some((line) => line.startsWith("warning:"))).toBe(false);
		expect((await readSuite(forgeDirectory)).forge_version).toBeUndefined();
	});
	test("a programming error in the warning's read propagates instead of being swallowed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { context } = await ctxIn(cwd);
		context.readSuiteIfPresent = async () => {
			throw new TypeError("suite reader is broken");
		};
		await expect(run(["estimate"], context)).rejects.toThrow(
			"suite reader is broken",
		);
	});
	test("a verb that fails does not stamp", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await writeSuite(forgeDirectory, SUITE);
		const path = join(forgeDirectory, "suite.yaml");
		const before = await readFile(path, "utf8");
		const { context } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(await readFile(path, "utf8")).toBe(before);
	});
	test("a suite.yaml that does not parse is left to the verb's own error, with no warning", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = join(forgeDirectory, "suite.yaml");
		await writeFile(path, "forge_version: 0.0.1\ntarget: [unclosed\n");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out.some((line) => line.startsWith("warning:"))).toBe(false);
		expect(out.at(-1)).toContain(path);
	});
	test("a verb that never reads suite.yaml still succeeds when the stamp cannot: one warning, exit 0, the file left as it was", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		await mkdir(forgeDirectory, { recursive: true });
		const path = join(forgeDirectory, "suite.yaml");
		const malformed = "target: [unclosed\n";
		await writeFile(path, malformed);
		const { context, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], context),
		).toBe(0);
		expect((await readFeature(forgeDirectory)).status).toBe("pending");
		const warnings = out.filter((line) => line.startsWith("warning:"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith(`warning: could not stamp ${path}: `);
		expect(await readFile(path, "utf8")).toBe(malformed);
	});
	test("a legacy kind: promptfoo-python is rewritten as python by a writing verb", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = join(forgeDirectory, "suite.yaml");
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace(
				"kind: python",
				"kind: promptfoo-python",
			),
		);
		const { context } = await ctxIn(cwd);
		expect(await run(["emit"], context)).toBe(0);
		const text = await readFile(path, "utf8");
		expect(text).toContain("kind: python");
		expect(text).not.toContain("promptfoo-python");
	});
	test("scenarios, cases, dedupe and import each stamp suite.yaml once they succeed, and a failed one does not", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = join(cwd, ".forge");
		const suitePath = join(forgeDirectory, "suite.yaml");
		const makeOlder = async (): Promise<void> => {
			const text = await readFile(suitePath, "utf8");
			await writeFile(
				suitePath,
				`forge_version: 0.0.1\n${text.replace(/^forge_version: .*\n/m, "")}`,
			);
			expect((await readSuite(forgeDirectory)).forge_version).toBe("0.0.1");
		};
		const stamped = async (): Promise<string | undefined> =>
			(await readSuite(forgeDirectory)).forge_version;
		let { context } = await ctxIn(cwd);
		expect(await run(["describe", "The bot classifies emails"], context)).toBe(
			0,
		);
		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], context)).toBe(0);
		await writeSuite(forgeDirectory, SUITE);

		await makeOlder();
		({ context } = await ctxIn(cwd));
		expect(await run(["scenarios"], context)).toBe(0);
		expect(await stamped()).toBe(FORGE_VERSION);

		({ context } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], context)).toBe(0);

		await makeOlder();
		({ context } = await ctxIn(cwd));
		expect(
			await run(
				["cases", "--scenario", "polite-rejection", "--n", "2"],
				context,
			),
		).toBe(0);
		expect(await stamped()).toBe(FORGE_VERSION);

		await makeOlder();
		({ context } = await ctxIn(cwd));
		expect(
			await run(["dedupe", "--scenario", "polite-rejection"], context),
		).toBe(0);
		expect(await stamped()).toBe(FORGE_VERSION);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n');
		await makeOlder();
		({ context } = await ctxIn(cwd));
		expect(await run(["import", jsonl], context)).toBe(0);
		expect(await stamped()).toBe(FORGE_VERSION);

		// A failed run leaves the old stamp.
		await makeOlder();
		({ context } = await ctxIn(cwd));
		expect(await run(["import", join(cwd, "missing.jsonl")], context)).toBe(1);
		expect(await stamped()).toBe("0.0.1");
	});
	test("an unknown verb neither warns nor stamps", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDirectory = await forgeWithApprovedCases(cwd);
		const path = await stampWith(forgeDirectory, "0.0.1");
		const before = await readFile(path, "utf8");
		const { context, out } = await ctxIn(cwd);
		expect(await run(["frobnicate"], context)).toBe(2);
		expect(out.some((line) => line.startsWith("warning:"))).toBe(false);
		expect(await readFile(path, "utf8")).toBe(before);
	});
});
