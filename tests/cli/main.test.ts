import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { CliContext } from "../../src/cli/context";
import { createContext } from "../../src/cli/context";
import { modelFlag, run } from "../../src/cli/main";
import {
	readCases,
	readFeature,
	readScenarios,
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
} from "../../src/core/files";

/** An unambiguously old timestamp: any real write resets a file's mtime to
 * "now", which is trivially distinguishable from this regardless of the
 * filesystem's mtime resolution — unlike comparing two mtimes taken moments
 * apart, which a coarse clock could report as equal by coincidence. */
const LONG_AGO = new Date("2000-01-01T00:00:00Z");

const MODEL = `fake/${resolve("tests/fixtures/cli-responses.json")}`;

async function ctxIn(cwd: string, stdinLines: string[] = []) {
	const out: string[] = [];
	const queue = [...stdinLines];
	const ctx = createContext({
		cwd,
		model: MODEL,
		stdin: async () => queue.shift() ?? "",
	});
	ctx.stdout = (l) => out.push(l);
	return { ctx, out };
}

describe("forge CLI end to end (fake provider)", () => {
	test("describe -> review -> scenarios -> review --all -> cases -> dedupe -> import", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");

		let { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], ctx),
		).toBe(0);
		expect((await readFeature(forgeDir)).status).toBe("pending");
		expect(out.at(-1)).toContain("feature.yaml");

		// scenarios refuse a pending feature
		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("pending");

		// approve the feature through review
		({ ctx, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		expect((await readFeature(forgeDir)).status).toBe("approved");

		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		expect(await readScenarios(forgeDir)).toHaveLength(6);

		// cases refuse when no scenario is approved
		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["cases", "--scenario", "polite-rejection"], ctx)).toBe(1);

		// approve one scenario with --all requires --scenario
		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["review", "--all"], ctx)).toBe(2);
		({ ctx, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0); // first pending scenario approved, rest skipped by empty stdin
		const scenarios = await readScenarios(forgeDir);
		expect(scenarios[0]?.status).toBe("approved");

		({ ctx, out } = await ctxIn(cwd));
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n", "2"], ctx),
		).toBe(0);
		expect(
			(await readCases(forgeDir, "polite-rejection")).map((c) => c.id),
		).toEqual(["polite-rejection-01", "polite-rejection-02"]);

		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["dedupe", "--scenario", "polite-rejection"], ctx)).toBe(
			0,
		);
		expect(
			(await readCases(forgeDir, "polite-rejection"))[1]?.duplicate_of,
		).toBe("polite-rejection-01");

		({ ctx, out } = await ctxIn(cwd));
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], ctx),
		).toBe(0);
		expect(
			(await readCases(forgeDir, "polite-rejection")).every(
				(c) => c.status === "approved",
			),
		).toBe(true);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["import", jsonl], ctx)).toBe(0);
		expect((await readCases(forgeDir, "imported")).map((c) => c.id)).toEqual([
			"imported-01",
			"imported-02",
		]);
		expect(
			(await readScenarios(forgeDir)).some((s) => s.id === "imported"),
		).toBe(true);
	});

	test("usage errors exit 2 and unknown verbs print usage", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx, out } = await ctxIn(cwd);
		expect(await run([], ctx)).toBe(2);
		expect(await run(["frobnicate"], ctx)).toBe(2);
		expect(out.join("\n")).toContain("usage:");
		// The two forms are mutually exclusive, and a bracket list said the
		// opposite until `--all --only` started being refused.
		expect(out.join("\n")).toContain(
			"review [--scenario id] [--only feature|scenarios|cases] | review --scenario id --all",
		);
	});

	test("missing model is a usage error (exit 2) naming the flag", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const out: string[] = [];
		const ctx = createContext({ cwd, env: {}, stdin: async () => "" });
		ctx.stdout = (l) => out.push(l);
		expect(await run(["describe", "x"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("--model");
	});
});

describe("review: interactive decisions beyond --all", () => {
	test("reports nothing pending once the feature is approved and no scenarios or cases exist yet", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { ctx, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx, out } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);

		({ ctx, out } = await ctxIn(cwd));
		expect(await run(["review"], ctx)).toBe(0);
		expect(out.at(-1)).toBe("review: nothing pending");
	});

	test("interactively approving a case asks for its expected value first, and an unanswered second case stays pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], describeCtx),
		).toBe(0);
		const { ctx: approveCtx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveCtx)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		const { ctx: importCtx } = await ctxIn(cwd);
		expect(await run(["import", jsonl], importCtx)).toBe(0);

		// decision "approve" for imported-01, then its expected fields (oracle
		// is derived "fields" from the feature's json output); the queue then
		// drains for imported-02, which askChoice maps to "skip".
		const { ctx: reviewCtx, out } = await ctxIn(cwd, [
			"approve",
			"type=rejection",
		]);
		expect(
			await run(
				["review", "--scenario", "imported", "--only", "cases"],
				reviewCtx,
			),
		).toBe(0);

		const cases = await readCases(forgeDir, "imported");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
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
		const forgeDir = join(cwd, ".forge");

		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);

		// Approve the first two scenarios (polite-rejection, huge-signature);
		// the rest are skipped by the drained stdin queue.
		({ ctx } = await ctxIn(cwd, ["approve", "approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);

		({ ctx } = await ctxIn(cwd));
		expect(await run(["cases", "--scenario", "polite-rejection"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["cases", "--scenario", "huge-signature"], ctx)).toBe(0);

		// Fully decide huge-signature's cases so it carries no pending items
		// into the next review pass at all.
		({ ctx } = await ctxIn(cwd));
		expect(
			await run(["review", "--scenario", "huge-signature", "--all"], ctx),
		).toBe(0);

		const scenariosPath = join(forgeDir, "scenarios.yaml");
		const hugeCasesPath = join(forgeDir, "cases", "huge-signature.yaml");
		await utimes(scenariosPath, LONG_AGO, LONG_AGO);
		await utimes(hugeCasesPath, LONG_AGO, LONG_AGO);

		// --only cases means no scenario gets a decision this pass either
		// (four scenarios are still pending but are filtered out), and only
		// polite-rejection has a pending case for the single "approve" to land on.
		const { ctx: caseReviewCtx, out } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "cases"], caseReviewCtx)).toBe(0);
		// One case approved, one skipped, and the four scenarios --only
		// filtered out of this pass are still pending -- "skipped" alone
		// would have reported 1 and hidden the other four.
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped, 0 re-opened, 5 still pending",
		);

		// The touched file really was rewritten (proves the assertions below
		// are about an untouched file, not a no-op review pass).
		const politeCases = await readCases(forgeDir, "polite-rejection");
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
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);

		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios", "--kinds", "happy"], ctx)).toBe(0);
		expect(await readScenarios(join(cwd, ".forge"))).toHaveLength(6);
	});

	test("rejects an unknown kind, naming the bad value and a valid one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);

		const { ctx: scenariosCtx, out } = await ctxIn(cwd);
		expect(
			await run(["scenarios", "--kinds", "happy,bogus"], scenariosCtx),
		).toBe(2);
		expect(out.at(-1)).toContain('"bogus"');
		expect(out.at(-1)).toContain("happy");
	});
});

describe("scenarios: --more validation (Finding 3)", () => {
	async function approvedFeature(cwd: string) {
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
	}

	test("rejects a non-numeric --more, naming the flag and the bad value", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedFeature(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["scenarios", "--more", "abc"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("--more");
		expect(out.at(-1)).toContain('"abc"');
		expect(out.at(-1)).toContain("positive integer");
	});

	test("rejects a non-positive --more (embedding a literal NaN/0 into the model prompt is not acceptable)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedFeature(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["scenarios", "--more", "0"], ctx)).toBe(2);
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
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
	}

	test("names the missing scenario when --scenario matches nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await withPendingScenarios(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["cases", "--scenario", "no-such-scenario"], ctx)).toBe(1);
		expect(out.at(-1)).toContain('scenario "no-such-scenario" not found');
		// The scenario id is carried in ForgeError's structured `details`,
		// not only interpolated into the message string -- ForgeError's own
		// constructor surfaces `details.id` as this "(id: ...)" suffix.
		expect(out.at(-1)).toContain("(id: no-such-scenario)");
	});

	test("refuses when no scenario is approved and none was named", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await withPendingScenarios(cwd); // scenarios exist but all remain pending

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["cases"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no approved scenario");
	});
});

describe("cases: --n validation (Finding 3)", () => {
	async function approvedScenario(cwd: string) {
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);
	}

	test("rejects a non-numeric --n, naming the flag and the bad value", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await approvedScenario(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n", "abc"], ctx),
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
		const { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n=0"], ctx),
		).toBe(2);
		expect(out.at(-1)).toContain("--n");
		expect(out.at(-1)).toContain('"0"');
		expect(out.at(-1)).toContain("positive integer");
	});
});

describe("dedupe: --scenario existence check (Finding 1)", () => {
	test("fails naming the scenario instead of writing a phantom empty cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["dedupe", "--scenario", "totally-bogus"], ctx)).toBe(1);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');

		const phantom = await stat(
			join(forgeDir, "cases", "totally-bogus.yaml"),
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
		const forgeDir = join(cwd, ".forge");
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "totally-bogus", "--all"], ctx),
		).toBe(1);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');

		const phantom = await stat(
			join(forgeDir, "cases", "totally-bogus.yaml"),
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
		const forgeDir = join(cwd, ".forge");
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], describeCtx),
		).toBe(0);
		const { ctx: approveCtx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveCtx)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		const { ctx: importCtx } = await ctxIn(cwd);
		expect(await run(["import", jsonl], importCtx)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["review", "--scenario", "imported", "--all"], ctx)).toBe(
			0,
		);

		const cases = await readCases(forgeDir, "imported");
		expect(cases.every((c) => c.status === "pending")).toBe(true);
		expect(cases.every((c) => c.expected === undefined)).toBe(true);
		expect(out.at(-1)).toBe(
			"review: approved 0 pending case(s) of imported; 2 left pending (no expected set — run `forge review --scenario imported` to fill them in)",
		);
	});

	test("in a mix, approves only the cases that have an expected and leaves the rest pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n", "2"], ctx),
		).toBe(0);

		// Both generated cases have `expected` from the fixture; strip it
		// from the second to simulate a case that has none (e.g. hand-edited),
		// so this test proves the partial case, not just the all-or-nothing one.
		const generated = await readCases(forgeDir, "polite-rejection");
		const first = generated[0];
		const second = generated[1];
		if (!first || !second) throw new Error("expected two generated cases");
		const { expected: _expected, ...secondWithoutExpected } = second;
		await writeCases(forgeDir, "polite-rejection", [
			first,
			secondWithoutExpected,
		]);

		const { ctx: allCtx, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], allCtx),
		).toBe(0);

		const after = await readCases(forgeDir, "polite-rejection");
		expect(after[0]?.status).toBe("approved");
		expect(after[1]?.status).toBe("pending");
		expect(after[1]?.expected).toBeUndefined();
		expect(out.at(-1)).toBe(
			"review: approved 1 pending case(s) of polite-rejection; 1 left pending (no expected set — run `forge review --scenario polite-rejection` to fill them in)",
		);
	});
});

describe("review --only validation (Finding 4)", () => {
	test("rejects an unknown --only value instead of reporting a false 'nothing pending'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		// A freshly described feature is pending -- genuinely pending work
		// exists, so "nothing pending" would be a lie here.
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "totally-bogus-kind"], ctx)).toBe(2);
		expect(out.at(-1)).toContain('"totally-bogus-kind"');
		expect(out.at(-1)).not.toContain("nothing pending");
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	});
});

describe("review --all requires --scenario: message and exit code (Minor)", () => {
	test("exits 2 and does not leak the internal usage routing marker", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["review", "--all"], ctx)).toBe(2);
		expect(out.at(-1)).toBe("error: --all requires --scenario");
	});
});

describe("import: zero positional arguments (Minor)", () => {
	test("fails naming what is missing, instead of crashing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["import"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("import needs a JSONL file path");
	});
});

describe("describe: --prompt-file missing", () => {
	test("fails cleanly with a ForgeError naming the file, instead of a raw ENOENT", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const missing = join(cwd, "missing-prompt.md");
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["describe", "text", "--prompt-file", missing], ctx)).toBe(
			1,
		);
		expect(out.at(-1)).toContain("file not found");
		expect(out.at(-1)).toContain(missing);
	});
});

describe("import: missing file", () => {
	test("fails cleanly, naming the file, when the JSONL path does not exist", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);
		const { ctx: approveCtx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review"], approveCtx)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		const missing = join(cwd, "nope.jsonl");
		expect(await run(["import", missing], ctx)).toBe(1);
		expect(out.at(-1)).toContain("file not found");
	});
});

describe("import: --oracle validation", () => {
	test("rejects an unknown oracle, naming the bad value and a valid one", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"x"}\n');
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["import", jsonl, "--oracle", "bogus"], ctx)).toBe(2);
		expect(out.at(-1)).toContain('"bogus"');
		expect(out.at(-1)).toContain("label");
	});
});

describe("modelFlag", () => {
	test("reads --model from raw argv", () => {
		expect(modelFlag(["describe", "x", "--model", "anthropic/haiku"])).toBe(
			"anthropic/haiku",
		);
	});

	test("returns undefined when --model is absent", () => {
		expect(modelFlag(["describe", "x"])).toBeUndefined();
	});
});

describe("run(): error classification", () => {
	test("an unrecognized option from parseArgs is reported as a usage error (exit 2)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["describe", "x", "--bogus"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("usage:");
	});

	test("a non-programming-error that is neither a ForgeError nor a parseArgs TypeError is printed cleanly (exit 1), not thrown", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		// "edit" on the only pending item (the feature) drives openInEditor's
		// real Bun.spawn with a deliberately broken $EDITOR, which throws
		// synchronously (ENOENT) before there is any exit code to return.
		// That's neither a ForgeError nor parseArgs's TypeError, and it is
		// not a programming-error type either (it's a plain Error carrying
		// a NodeJS.ErrnoException .code) -- so run() now catches it and
		// prints the same clean `error: ...` line a real user gets for any
		// other external failure, instead of dumping Bun's raw ENOENT stack.
		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		const originalEditor = process.env.EDITOR;
		process.env.EDITOR = "totally-bogus-editor-that-does-not-exist";
		try {
			expect(await run(["review"], ctx)).toBe(1);
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
		const { ctx, out } = await ctxIn(cwd);
		ctx.llm = {
			generate: async () => {
				throw new Error("This model is currently experiencing high demand.");
			},
		};
		expect(await run(["describe", "text"], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			"error: This model is currently experiencing high demand.",
		);
	});

	test("a genuine programming error (TypeError) still propagates with its real stack, even from Llm.generate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx } = await ctxIn(cwd);
		ctx.llm = {
			generate: async () => {
				throw new TypeError("Cannot read properties of undefined");
			},
		};
		let err: unknown;
		try {
			await run(["describe", "text"], ctx);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TypeError);
	});
});

describe("createContext defaults", () => {
	test("the default stdout writes through console.log", () => {
		const original = console.log;
		const lines: string[] = [];
		console.log = (l: string) => lines.push(l);
		try {
			const ctx = createContext({
				cwd: "/tmp",
				env: { FORGE_MODEL: "fake/x" },
				stdin: async () => "",
			});
			ctx.stdout("hello");
		} finally {
			console.log = original;
		}
		expect(lines).toEqual(["hello"]);
	});
});

describe("the downstream gate: nothing runs on a pending feature (whole-branch Finding 1)", () => {
	/** A freshly described feature, left pending on purpose. */
	async function pendingFeature(cwd: string) {
		const { ctx } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], ctx),
		).toBe(0);
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	}

	/** Refuses loudly if the verb reaches the model at all. */
	function noModelCalls(ctx: Awaited<ReturnType<typeof ctxIn>>["ctx"]) {
		ctx.llm = {
			generate: async () => {
				throw new Error("the model was called for a pending feature");
			},
		};
	}

	test("scenarios refuses, naming feature.yaml and the feature id", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);

		const { ctx, out } = await ctxIn(cwd);
		noModelCalls(ctx);
		expect(await run(["scenarios"], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		);
	});

	test("cases refuses before spending a single token", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);

		const { ctx, out } = await ctxIn(cwd);
		noModelCalls(ctx);
		expect(await run(["cases"], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
		);
	});

	test("import refuses instead of exiting 0, and writes no cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingFeature(cwd);
		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n');

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["import", jsonl], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: feature is pending; run \`forge review\` first (file: ${join(cwd, ".forge", "feature.yaml")}, id: classify-email)`,
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
		let { ctx } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], ctx),
		).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
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

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["describe", "something else entirely"], ctx)).toBe(1);
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

		const { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["describe", "--force", "something else entirely"], ctx),
		).toBe(0);
		expect(out.at(-1)).toContain("written as pending");
		expect((await readFeature(join(cwd, ".forge"))).status).toBe("pending");
	});

	test("a still-pending feature is not reviewed work, so re-describing over it is allowed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: first } = await ctxIn(cwd);
		expect(await run(["describe", "text"], first)).toBe(0);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["describe", "text again"], ctx)).toBe(0);
		expect(out.at(-1)).toContain("written as pending");
	});
});

describe("review: an edit that renames an item lands on disk (whole-branch Finding 3)", () => {
	/**
	 * A real `$EDITOR`: a tiny script that rewrites the file it is handed,
	 * substituting one line for another. `sed -i` is spelled differently on
	 * macOS and GNU, so this writes through a temp file instead.
	 */
	async function editorReplacing(
		dir: string,
		from: string,
		to: string,
	): Promise<string> {
		const path = join(dir, `fake-editor-${from.replace(/\W/g, "")}.sh`);
		await writeFile(
			path,
			`#!/bin/sh\nsed 's|^${from}$|${to}|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

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
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
	}

	async function approvedScenarioWithTwoCases(cwd: string) {
		await pendingScenarios(cwd);
		let { ctx } = await ctxIn(cwd, ["approve"]);
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(
			await run(["cases", "--scenario", "polite-rejection", "--n", "2"], ctx),
		).toBe(0);
	}

	test("renaming a scenario is refused by name and re-asked, and the next review pass still works", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		// The scenario has to be pending to be offered, and has to have
		// cases for the rename to be able to orphan them.
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDir, "polite-rejection", [
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
		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);
		});

		expect(out).toContain(
			`cannot apply: a scenario's id cannot be changed in review (from "polite-rejection" to "polite-rejection-fixed"): it names .forge/cases/<id>.yaml — rename the file and each case's scenario field by hand (id: polite-rejection)`,
		);
		const scenarios = await readScenarios(forgeDir);
		expect(scenarios.map((s) => [s.id, s.status])).toEqual([
			["polite-rejection", "pending"],
		]);

		// The half-applied rename used to leave every case of that scenario
		// naming an id scenarios.yaml no longer held, which the next pass
		// refused wholesale. A second run still offers them.
		const { ctx: nextCtx, out: nextOut } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				nextCtx,
			),
		).toBe(0);
		expect(nextOut).toContain("--- case polite-rejection-01 ---");
		expect(
			(await readCases(forgeDir, "polite-rejection")).map((c) => c.status),
		).toEqual(["approved", "pending"]);
	});

	test("a renamed case is written back under its new id, in its own file, with no second file invented", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await approvedScenarioWithTwoCases(cwd);
		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection-01",
			"id: polite-rejection-42",
		);

		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					ctx,
				),
			).toBe(0);
		});

		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
			["polite-rejection-42", "edited"],
			["polite-rejection-02", "pending"],
		]);
		expect(await readdir(join(forgeDir, "cases"))).toEqual([
			"polite-rejection.yaml",
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 1 skipped, 0 re-opened, 1 still pending",
		);
	});

	test("changing a case's scenario is refused by name and re-asked, inventing no cases file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await approvedScenarioWithTwoCases(cwd);
		const editor = await editorReplacing(
			cwd,
			"scenario: polite-rejection",
			"scenario: huge-signature",
		);

		// "edit" is refused, the same item is re-asked, and the drained
		// queue then answers "" -- which askChoice maps to skip.
		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					ctx,
				),
			).toBe(0);
		});

		expect(
			out.some(
				(l) =>
					l ===
					`cannot apply: a case's scenario cannot be changed in review (from "polite-rejection" to "huge-signature"); move the case between .forge/cases/<scenario>.yaml files instead (id: polite-rejection-01)`,
			),
		).toBe(true);
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.scenario, c.status])).toEqual([
			["polite-rejection-01", "polite-rejection", "pending"],
			["polite-rejection-02", "polite-rejection", "pending"],
		]);
		expect(await readdir(join(forgeDir, "cases"))).toEqual([
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
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);

		// The feature is approved, so nothing of kind `feature` is pending --
		// but six scenarios are.
		const { ctx: onlyCtx, out } = await ctxIn(cwd);
		expect(await run(["review", "--only", "feature"], onlyCtx)).toBe(0);
		expect(out.at(-1)).toBe(
			"review: nothing pending matching --only feature; 6 item(s) still pending outside that filter",
		);
	});
});

describe("review --scenario is checked on the interactive path too (whole-branch Finding 4)", () => {
	test("a typo names the unknown scenario and exits 1, instead of 'nothing pending' and 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);

		// Six scenarios really are pending here, so "nothing pending" was
		// not only unhelpful, it was false.
		const { ctx: reviewCtx, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection-typo"], reviewCtx),
		).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "polite-rejection-typo" not found (id: polite-rejection-typo)',
		);
		expect(out.join("\n")).not.toContain("nothing pending");
	});

	test("the same typo is refused with --only, which is parsed before it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);

		const { ctx: reviewCtx, out } = await ctxIn(cwd);
		expect(
			await run(
				["review", "--scenario", "totally-bogus", "--only", "cases"],
				reviewCtx,
			),
		).toBe(1);
		expect(out.at(-1)).toContain('scenario "totally-bogus" not found');
	});
});

describe("dedupe never writes a phantom empty cases file (whole-branch Finding 5)", () => {
	/** describe -> approve -> scenarios, so real scenarios exist with no cases. */
	async function scenariosWithoutCases(cwd: string) {
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
	}

	test("a known scenario with no cases yet is named, not written as an empty list", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await scenariosWithoutCases(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["dedupe", "--scenario", "polite-rejection"], ctx)).toBe(
			1,
		);
		expect(out.at(-1)).toBe(
			'error: scenario "polite-rejection" has no cases yet; run `forge cases --scenario polite-rejection` first (id: polite-rejection)',
		);
		expect(out.join("\n")).not.toContain("0 marked as duplicates");

		const casesDir = await readdir(join(forgeDir, "cases")).catch(
			() => [] as string[],
		);
		expect(casesDir).toEqual([]);
	});

	test("with no cases file anywhere, bare dedupe refuses instead of exiting 0 having done nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await scenariosWithoutCases(cwd);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["dedupe"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no cases to dedupe");
		expect(out.at(-1)).toContain(join(cwd, ".forge", "cases"));
	});
});

describe("review holds the human to the same oracle contract as the model (whole-branch Finding 6)", () => {
	test("a label outside the feature's labels is refused by name and re-asked, and only the valid one is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		let { ctx } = await ctxIn(cwd);
		expect(
			await run(["describe", "The bot classifies hiring emails"], ctx),
		).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);

		// --oracle label pins the imported scenario to the label oracle, the
		// one the feature's `labels` list constrains.
		const jsonl = join(cwd, "prod.jsonl");
		await writeFile(jsonl, '{"email":"real one"}\n{"email":"real two"}\n');
		({ ctx } = await ctxIn(cwd));
		expect(await run(["import", jsonl, "--oracle", "label"], ctx)).toBe(0);

		const { ctx: reviewCtx, out } = await ctxIn(cwd, [
			"approve",
			"maybe",
			"rejection",
		]);
		expect(
			await run(
				["review", "--scenario", "imported", "--only", "cases"],
				reviewCtx,
			),
		).toBe(0);

		expect(out).toContain(
			`label "maybe" is not one of the feature's labels; try again`,
		);
		const cases = await readCases(forgeDir, "imported");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
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
		const forgeDir = join(cwd, ".forge");
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);

		// A hand-written cases file: the label was never checked against
		// the feature on its way in.
		await writeCases(forgeDir, "polite-rejection", [
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
		const { ctx: reviewCtx, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				reviewCtx,
			),
		).toBe(0);

		expect(out).toContain(
			'cannot apply: expected does not match the oracle: label "maybe" is not one of the feature\'s labels (id: polite-rejection-01)',
		);
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
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
		const forgeDir = join(cwd, ".forge");
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);

		// One good case and one whose label the feature never declared.
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx: allCtx, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], allCtx),
		).toBe(0);

		expect(out).toContain(
			`review: polite-rejection-02: label "maybe" is not one of the feature's labels`,
		);
		expect(out.at(-1)).toBe(
			"review: approved 1 pending case(s) of polite-rejection; 1 left pending (expected does not match the label oracle — see above)",
		);
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
			["polite-rejection-01", "approved"],
			["polite-rejection-02", "pending"],
		]);
	});
});

describe("review: a decision applies to at most one entry (regression)", () => {
	test("two cases sharing an id: approving one leaves the other intact, with its own fields and status", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);

		// A cases file where two entries carry the same id -- the state the
		// review loop must not resolve by writing one decision over both.
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx: reviewCtx, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				reviewCtx,
			),
		).toBe(0);
		// Only one item is offered: pendingItems places one entry per id, so
		// the twin is not reviewed this pass. That is a limitation, not the
		// defect under test -- the defect is what happens to it on write.
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 re-opened, 0 still pending",
		);

		// Length alone would pass against a YAML alias: assert the second
		// entry's own content and its own status survived.
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.input.email, c.status])).toEqual([
			["the first one", "approved"],
			["the second one", "pending"],
		]);
		expect(cases[1]?.expected).toEqual({ label: "acknowledgement" });
		// Two distinct objects, not one written twice.
		expect(cases[0]).not.toBe(cases[1]);
		const raw = await readFile(
			join(forgeDir, "cases", "polite-rejection.yaml"),
			"utf8",
		);
		expect(raw).not.toContain("*");
		expect(raw).not.toContain("&");
	});
});

describe("review: an edit cannot rename an item onto an id already in its file", () => {
	async function editorReplacing(
		dir: string,
		from: string,
		to: string,
	): Promise<string> {
		const path = join(dir, `fake-editor-${from.replace(/\W/g, "")}.sh`);
		await writeFile(
			path,
			`#!/bin/sh\nsed 's|^${from}$|${to}|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

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
		let { ctx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd, ["approve"]));
		expect(await run(["review"], ctx)).toBe(0);
		({ ctx } = await ctxIn(cwd));
		expect(await run(["scenarios"], ctx)).toBe(0);

		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection",
			"id: huge-signature",
		);
		const { ctx: reviewCtx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review", "--only", "scenarios"], reviewCtx)).toBe(0);
		});

		// A scenario's id cannot be changed to anything, so "pick an id
		// nothing else uses" was advice no free id could satisfy: the
		// refusal a person can act on is the one that names the file move.
		expect(out).toContain(
			'cannot apply: a scenario\'s id cannot be changed in review (from "polite-rejection" to "huge-signature"): it names .forge/cases/<id>.yaml — rename the file and each case\'s scenario field by hand (id: polite-rejection)',
		);
		expect(out.join("\n")).not.toContain("pick an id nothing else uses");
		const scenarios = await readScenarios(join(cwd, ".forge"));
		expect(scenarios.map((s) => [s.id, s.status])).toEqual([
			["polite-rejection", "pending"],
			["huge-signature", "pending"],
			["ack-quiz", "pending"],
			["newsletter", "pending"],
			["injection", "pending"],
			["portuguese", "pending"],
		]);
	});

	test("the feature has no siblings, so editing it is not blocked by its own id", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

		const editor = await editorReplacing(
			cwd,
			"purpose: Classify a hiring-process email",
			"purpose: Classify a hiring-process email, reviewed by hand",
		);
		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review"], ctx)).toBe(0);
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
		kind: "promptfoo-python" as const,
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5"],
	},
	judges: ["google/gemini-3.5-flash"],
	repeat: 2,
	include: [],
};

async function forgeWithApprovedCases(cwd: string) {
	const forgeDir = join(cwd, ".forge");
	await writeFeature(forgeDir, FEATURE);
	await writeScenarios(forgeDir, [
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
	await writeCases(forgeDir, "polite-rejection", [
		{
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "We will not proceed." },
			expected: { label: "rejection" },
			status: "approved",
			generated_by: "t",
		},
	]);
	await writeCases(forgeDir, "vague-rubric", [
		{
			id: "vague-rubric-01",
			scenario: "vague-rubric",
			input: { email: "Thanks for applying!" },
			expected: { rubric: "says it is an automated receipt" },
			status: "edited",
			generated_by: "t",
		},
	]);
	await writeSuite(forgeDir, SUITE);
	return forgeDir;
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
	const forgeDir = join(cwd, ".forge");
	await writeFeature(forgeDir, FEATURE);
	await writeScenarios(forgeDir, [
		{
			id: "polite-rejection",
			kind: "happy",
			oracle,
			description: "d",
			status: "approved",
		},
	]);
	return forgeDir;
}

describe("review names a case whose scenario is missing instead of asking for a rubric", () => {
	test("exits 1 naming the case and the scenario it points at, and decides nothing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedScenario(cwd);
		// The file is named for a scenario that exists; the case inside
		// points at one that does not. `oracleOf` used to answer "rubric"
		// here and ask the person for a rubric sentence for a case whose
		// oracle nobody knows.
		await writeCases(forgeDir, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "ghost",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { ctx, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				ctx,
			),
		).toBe(1);
		expect(out.at(-1)).toBe(
			`error: case polite-rejection-01 names scenario "ghost", which is not in scenarios.yaml (file: ${join(forgeDir, "scenarios.yaml")}, id: polite-rejection-01)`,
		);
		// Refused before the first prompt, so nothing was asked and nothing
		// was written: a broken file is not a decision to retry.
		expect(out.some((l) => l.includes("rubric sentence"))).toBe(false);
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => c.status)).toEqual(["pending"]);
	});
});

describe("import --oracle cannot silently change an existing imported scenario", () => {
	/** An approved feature and one JSONL line, ready to import. */
	async function importable(cwd: string, name: string, email: string) {
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		const path = join(cwd, name);
		await writeFile(path, `${JSON.stringify({ email })}\n`);
		return { forgeDir, path };
	}

	test("a second import with a different --oracle exits 1 naming the oracle on disk, and writes no case", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { forgeDir, path } = await importable(cwd, "prod.jsonl", "one");
		// `rubric` is not what this feature derives (its output is a label),
		// so the scenario on disk proves the first --oracle was honoured.
		const { ctx: firstCtx } = await ctxIn(cwd);
		expect(await run(["import", path, "--oracle", "rubric"], firstCtx)).toBe(0);

		const second = join(cwd, "more.jsonl");
		await writeFile(second, '{"email":"two"}\n');
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["import", second, "--oracle", "label"], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			`error: scenario "imported" already exists with oracle rubric; --oracle cannot change it — edit .forge/scenarios.yaml (file: ${join(forgeDir, "scenarios.yaml")}, id: imported)`,
		);
		// Refused before any write: the second line did not land, and the
		// scenario still carries the oracle its cases were reviewed against.
		expect((await readCases(forgeDir, "imported")).map((c) => c.id)).toEqual([
			"imported-01",
		]);
		expect((await readScenarios(forgeDir)).map((s) => s.oracle)).toEqual([
			"rubric",
		]);
	});

	test("a second import repeating the same --oracle is accepted and imports its line", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { forgeDir, path } = await importable(cwd, "prod.jsonl", "one");
		const { ctx: firstCtx } = await ctxIn(cwd);
		expect(await run(["import", path, "--oracle", "rubric"], firstCtx)).toBe(0);

		const second = join(cwd, "more.jsonl");
		await writeFile(second, '{"email":"two"}\n');
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["import", second, "--oracle", "rubric"], ctx)).toBe(0);
		expect(out.at(-1)).toContain("1 new pending cases");
		expect((await readCases(forgeDir, "imported")).map((c) => c.id)).toEqual([
			"imported-01",
			"imported-02",
		]);
	});
});

describe("review --all refuses --only instead of parsing it and ignoring it", () => {
	test("exits 2 naming both flags, and the case --all would have approved stays pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDir, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);

		const { ctx, out } = await ctxIn(cwd);
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
				ctx,
			),
		).toBe(2);
		expect(out.at(-1)).toContain("--all");
		expect(out.at(-1)).toContain("--only");
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => c.status)).toEqual(["pending"]);
	});
});

describe("review: a decision taken in this pass is visible to the rest of it", () => {
	/**
	 * A real `$EDITOR` that duplicates the line matching `line`, replacing
	 * `from` with `to` in the copy — an append that keeps the original
	 * line's indentation, whatever it is. `sed` cannot portably insert a
	 * newline in a replacement (BSD and GNU disagree), so this uses awk.
	 */
	async function editorAppendingLabel(dir: string, from: string, to: string) {
		const path = join(dir, "fake-editor-label.sh");
		await writeFile(
			path,
			`#!/bin/sh\nawk '/${from}$/ { print; sub(/${from}$/, "${to}"); print; next } { print }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

	test("a label added by editing the feature is accepted for a case approved later in the same pass", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, {
			...FEATURE,
			output: { kind: "label", labels: ["rejection"] },
			status: "pending",
		});
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDir, "polite-rejection", [
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
		const { ctx, out } = await ctxIn(cwd, ["edit", "approve"]);
		try {
			expect(await run(["review"], ctx)).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}

		expect((await readFeature(forgeDir)).output.labels).toEqual([
			"rejection",
			"shortlist",
		]);
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => c.status)).toEqual(["approved"]);
		// Refused against the feature as it was read off disk, the case
		// would have been re-asked and then skipped by the drained queue.
		expect(out.some((l) => l.includes('label "shortlist" is not one of'))).toBe(
			false,
		);
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 1 edited, 0 skipped, 0 re-opened, 0 still pending",
		);
	});
});

describe("review: editing a scenario's oracle re-opens the cases it invalidates", () => {
	/** A real `$EDITOR`: replaces one whole line with another. */
	async function editorReplacing(dir: string, from: string, to: string) {
		const path = join(dir, `fake-editor-${from.replace(/\W/g, "")}.sh`);
		await writeFile(
			path,
			`#!/bin/sh\nsed 's|^${from}$|${to}|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

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
		ctx: CliContext,
	) {
		const editor = await editorReplacing(
			cwd,
			"oracle: label",
			"oracle: rubric",
		);
		await withEditor(editor, async () => {
			expect(await run(["review"], ctx)).toBe(0);
		});
		return out;
	}

	test("two approved label cases go back to pending, keep their expected, and the change is reported", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, ctx);

		expect((await readScenarios(forgeDir))[0]?.oracle).toBe("rubric");
		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => c.status)).toEqual(["pending", "pending"]);
		// The expected is kept, not thrown away: it is the reviewer's own
		// answer, and what it has to be rewritten into is up to them.
		expect(cases.map((c) => c.expected)).toEqual([
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

	test("a case whose expected already fits the new oracle stays approved, and a rejected one is not re-opened", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, ctx);

		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.status])).toEqual([
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
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "pending",
			},
		]);
		await writeCases(forgeDir, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { rubric: "says it is a rejection" },
				status: "approved",
				generated_by: "hand",
			},
		]);
		const casesPath = join(forgeDir, "cases", "polite-rejection.yaml");
		await utimes(casesPath, LONG_AGO, LONG_AGO);

		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await editOracleToRubric(cwd, out, ctx);

		expect((await readScenarios(forgeDir))[0]?.oracle).toBe("rubric");
		expect(out).toContain(
			"review: scenario polite-rejection changed oracle label → rubric; 0 case(s) re-opened — edit each to give it an expected the new oracle accepts",
		);
		// No case changed, so the file no decision touched is not rewritten.
		expect((await stat(casesPath)).mtime.getTime()).toBe(LONG_AGO.getTime());
	});
});

describe("review: what a rename does to the pointers at it, and what a twin id does to the pass", () => {
	async function editorReplacing(dir: string, from: string, to: string) {
		const path = join(dir, `fake-editor-${from.replace(/\W/g, "")}.sh`);
		await writeFile(
			path,
			`#!/bin/sh\nsed 's|^${from}$|${to}|' "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n`,
		);
		await chmod(path, 0o755);
		return path;
	}

	test("a case renamed in review takes every duplicate_of pointing at it along, in the same write", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDir, "polite-rejection", [
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
		const { ctx } = await ctxIn(cwd, ["edit"]);
		try {
			expect(
				await run(
					["review", "--scenario", "polite-rejection", "--only", "cases"],
					ctx,
				),
			).toBe(0);
		} finally {
			if (original === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = original;
		}

		const cases = await readCases(forgeDir, "polite-rejection");
		expect(cases.map((c) => [c.id, c.duplicate_of])).toEqual([
			["polite-rejection-42", undefined],
			["polite-rejection-02", "polite-rejection-42"],
		]);
		// The pointer moved, the skipped case was not otherwise decided.
		expect(cases.map((c) => c.status)).toEqual(["edited", "pending"]);
	});

	test("review --all says it too: the twin is not a property of the interactive path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx, out } = await ctxIn(cwd);
		expect(
			await run(["review", "--scenario", "polite-rejection", "--all"], ctx),
		).toBe(0);
		expect(out).toContain(
			`review: ${join(forgeDir, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; only the first is offered — fix the file`,
		);
	});

	test("a cases file holding two entries under one id says so, naming the id and the file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedScenario(cwd);
		await writeCases(forgeDir, "polite-rejection", [
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

		const { ctx, out } = await ctxIn(cwd, ["approve"]);
		expect(
			await run(
				["review", "--scenario", "polite-rejection", "--only", "cases"],
				ctx,
			),
		).toBe(0);
		expect(out).toContain(
			`review: ${join(forgeDir, "cases", "polite-rejection.yaml")} holds 2 entries under id "polite-rejection-01"; only the first is offered — fix the file`,
		);
	});
});

describe("dedupe checks every scenario before it writes the first one", () => {
	test("an empty cases file later in the list is refused with the earlier file untouched", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
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
		await writeCases(forgeDir, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "one" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "hand",
			},
		]);
		await writeCases(forgeDir, "zzz-empty", []);
		// `listCaseScenarios` sorts, so polite-rejection is reached first.
		const first = join(forgeDir, "cases", "polite-rejection.yaml");
		await utimes(first, LONG_AGO, LONG_AGO);

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["dedupe"], ctx)).toBe(1);
		expect(out.at(-1)).toBe(
			'error: scenario "zzz-empty" has no cases yet; run `forge cases --scenario zzz-empty` first (id: zzz-empty)',
		);
		expect((await stat(first)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(out.some((l) => l.includes("marked as duplicates"))).toBe(false);
	});
});

describe("estimate", () => {
	test("prints one target row, one judge row, the total, the prices date and the notes; exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
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
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "solo",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDir, "solo", [
			{
				id: "solo-01",
				scenario: "solo",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDir, SUITE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		expect(out[0]).toMatch(
			/^estimate: 1 case, 0 with a rubric; prices dated \d{4}-\d{2}-\d{2}$/m,
		);
	});
	test("counts the prompt file when feature.prompt_file is set, and drops the prompt note", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeFile(join(cwd, "prompt.txt"), "p".repeat(4000));
		await writeFeature(forgeDir, { ...FEATURE, prompt_file: "prompt.txt" });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		const target = out.find((l) => l.includes("anthropic/claude-haiku-4-5"));
		// two cases × repeat 2 = 4 calls; each call is 1000 prompt tokens + ceil(20 / 4) input tokens → 4020 in
		expect(target).toMatch(/ {2}4 calls {4}40\d\d in/);
		expect(out.join("\n")).not.toContain("application prompt not counted");
	});
	test("a missing prompt_file is a ForgeError naming it (exit 1), not a silent zero", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeFeature(forgeDir, { ...FEATURE, prompt_file: "gone.txt" });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("gone.txt");
	});
	test("an absolute prompt_file is read from that path, not joined under the application root", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		const outside = await mkdtemp(join(tmpdir(), "forge-prompt-"));
		const absolutePrompt = join(outside, "prompt.txt");
		await writeFile(absolutePrompt, "p".repeat(4000));
		await writeFeature(forgeDir, { ...FEATURE, prompt_file: absolutePrompt });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		const target = out.find((l) => l.includes("anthropic/claude-haiku-4-5"));
		// Same math as the relative-path case above: 4 calls, each 1000 prompt
		// tokens + ceil(20 / 4) input tokens -> 4020 in. An absolute
		// prompt_file that got joined under forgeDir/.. instead of resolved
		// would not exist there, and this would read as a missing-file error.
		expect(target).toMatch(/ {2}4 calls {4}40\d\d in/);
	});
	test("a prompt_file that is a directory names the real cause (exit 1), not 'file not found'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await mkdir(join(cwd, "prompt-dir"));
		await writeFeature(forgeDir, { ...FEATURE, prompt_file: "prompt-dir" });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("is a directory");
	});
	test("pending items are excluded and reported, not refused", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDir, "polite-rejection", [
			{
				id: "polite-rejection-01",
				scenario: "polite-rejection",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		expect(out).toContain(
			"estimate: 1 item excluded; run `forge review` to include it:",
		);
		expect(out).toContain(
			"  case polite-rejection-01 is pending (" +
				join(forgeDir, "cases", "polite-rejection.yaml") +
				")",
		);
	});
	test("more than one pending item pluralizes the exclusion message, listing both in scenario order", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDir, "polite-rejection", [
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
		await writeCases(forgeDir, "vague-rubric", [
			{
				id: "vague-rubric-01",
				scenario: "vague-rubric",
				input: { email: "y" },
				expected: { rubric: "z" },
				status: "pending",
				generated_by: "t",
			},
		]);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		expect(out.slice(-3)).toEqual([
			"estimate: 2 items excluded; run `forge review` to include them:",
			`  case polite-rejection-01 is pending (${join(forgeDir, "cases", "polite-rejection.yaml")})`,
			`  case vague-rubric-01 is pending (${join(forgeDir, "cases", "vague-rubric.yaml")})`,
		]);
	});
	test("a rejected included scenario is excluded without telling the person to review it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeScenarios(forgeDir, [
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
		await writeSuite(forgeDir, {
			...SUITE,
			include: ["polite-rejection", "vague-rubric"],
		});
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(0);
		expect(out.slice(-2)).toEqual([
			"estimate: 1 item excluded:",
			`  scenario vague-rubric is rejected (${join(forgeDir, "scenarios.yaml")})`,
		]);
		expect(out.join("\n")).not.toContain("forge review");
	});
	test("selecting no case at all exits 1 naming the cases directory, printing no table", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDir, SUITE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no approved case to estimate");
		expect(out.at(-1)).toContain(join(forgeDir, "cases"));
		expect(out.join("\n")).not.toContain("prices dated");
	});
	test("a missing suite.yaml exits 1 with the example to copy", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["estimate"], ctx)).toBe(1);
		expect(out.join("\n")).toContain("suite.yaml not found");
		expect(out.join("\n")).toContain("judges:");
	});
	test("an unknown flag is a usage error (exit 2)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { ctx } = await ctxIn(cwd);
		expect(await run(["estimate", "--bogus"], ctx)).toBe(2);
	});
});

describe("emit", () => {
	test("writes promptfooconfig.yaml and the shim, prints what it wrote, exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(0);
		const cfg = parse(
			await readFile(join(forgeDir, "promptfooconfig.yaml"), "utf8"),
		);
		expect(
			cfg.tests.map((t: { description: string }) => t.description),
		).toEqual(["polite-rejection-01", "vague-rubric-01"]);
		expect(cfg.providers[0].id).toBe("file://forge_target.py");
		expect(await readFile(join(forgeDir, "forge_target.py"), "utf8")).toContain(
			'INPUTS = ["email"]',
		);
		expect(out).toContain(
			`emit: wrote ${join(forgeDir, "promptfooconfig.yaml")} (2 cases, 2 scenarios, 1 target model, 1 judge)`,
		);
		expect(out).toContain(
			`emit: wrote ${join(forgeDir, "forge_target.py")}; edit run_application() to call your application`,
		);
	});
	test("a single case, scenario, target model and judge pluralizes to singular", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "solo",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeCases(forgeDir, "solo", [
			{
				id: "solo-01",
				scenario: "solo",
				input: { email: "x" },
				expected: { label: "rejection" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDir, SUITE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(0);
		expect(out).toContain(
			`emit: wrote ${join(forgeDir, "promptfooconfig.yaml")} (1 case, 1 scenario, 1 target model, 1 judge)`,
		);
	});
	test("never overwrites an existing shim, and says it kept it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		const shim = join(forgeDir, "forge_target.py");
		await writeFile(shim, "# mine\n");
		await utimes(shim, LONG_AGO, LONG_AGO);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(0);
		expect(await readFile(shim, "utf8")).toBe("# mine\n");
		expect((await stat(shim)).mtime.getTime()).toBe(LONG_AGO.getTime());
		expect(out).toContain(`emit: kept existing ${shim}`);
	});
	test("refuses on pending items, lists every one, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeCases(forgeDir, "polite-rejection", [
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
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain(
			"error: emit refused: 2 items block it; run `forge review`",
		);
		expect(text).toContain("case polite-rejection-01 is pending");
		expect(text).toContain("case polite-rejection-02 is pending");
		await expect(
			stat(join(forgeDir, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(stat(join(forgeDir, "forge_target.py"))).rejects.toThrow();
	});
	test("a rejected included scenario blocks emit without telling the person to review it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "rejected",
			},
		]);
		await writeSuite(forgeDir, { ...SUITE, include: ["polite-rejection"] });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain("error: emit refused: 1 item blocks it");
		expect(text).toContain("scenario polite-rejection is rejected");
		expect(text).not.toContain("forge review");
	});
	test("a case whose expected no longer matches its scenario's oracle blocks emit, naming both", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		// The oracle was edited to `fields` after the case was approved
		// against `label`; the expected on disk is now the wrong shape.
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "fields",
				description: "d",
				status: "edited",
			},
		]);
		await writeSuite(forgeDir, { ...SUITE, include: ["polite-rejection"] });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		const text = out.join("\n");
		expect(text).toContain(
			"error: emit refused: 1 item blocks it; run `forge review`",
		);
		expect(text).toContain(
			`case polite-rejection-01: oracle is fields but expected.fields is missing (${join(forgeDir, "cases", "polite-rejection.yaml")})`,
		);
		await expect(
			stat(join(forgeDir, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(stat(join(forgeDir, "forge_target.py"))).rejects.toThrow();
	});
	test("a target.entry that is a path, not a file name, is refused before anything is written", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeSuite(forgeDir, {
			...SUITE,
			target: { ...SUITE.target, entry: "../escaped.py" },
		});
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		expect(out.at(-1)).toContain(
			"target.entry must be a file name inside .forge, not a path",
		);
		expect(out.at(-1)).toContain(join(forgeDir, "suite.yaml"));
		await expect(stat(join(cwd, "escaped.py"))).rejects.toThrow();
		await expect(
			stat(join(forgeDir, "promptfooconfig.yaml")),
		).rejects.toThrow();
	});
	test("--format jsonl writes cases.jsonl and no shim", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "jsonl"], ctx)).toBe(0);
		const lines = (await readFile(join(forgeDir, "cases.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.id)).toEqual([
			"polite-rejection-01",
			"vague-rubric-01",
		]);
		await expect(stat(join(forgeDir, "forge_target.py"))).rejects.toThrow();
		expect(out).toContain(
			`emit: wrote ${join(forgeDir, "cases.jsonl")} (2 cases)`,
		);
	});
	test("an unknown --format is a usage error naming the valid values", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeWithApprovedCases(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "xml"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("promptfoo, jsonl");
	});
	test("a pending feature is refused before anything is read (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeWithApprovedCases(cwd);
		await writeFeature(forgeDir, { ...FEATURE, status: "pending" });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("pending");
	});
	test("--format jsonl with zero approved cases and no blockers refuses, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDir, SUITE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit", "--format", "jsonl"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no approved case");
		expect(out.at(-1)).toContain(join(forgeDir, "cases"));
		await expect(stat(join(forgeDir, "cases.jsonl"))).rejects.toThrow();
	});
	test("--format promptfoo (default) with zero approved cases and no blockers refuses, writes nothing, exits 1", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "d",
				status: "approved",
			},
		]);
		await writeSuite(forgeDir, SUITE);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["emit"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no approved case");
		expect(out.at(-1)).toContain(join(forgeDir, "cases"));
		await expect(
			stat(join(forgeDir, "promptfooconfig.yaml")),
		).rejects.toThrow();
		await expect(stat(join(forgeDir, "forge_target.py"))).rejects.toThrow();
	});
});

describe("report", () => {
	const RESULTS = resolve("tests/fixtures/promptfoo-results-0.123.0.json");

	async function forgeMatchingFixture(cwd: string) {
		const forgeDir = join(cwd, ".forge");
		await writeFeature(forgeDir, FEATURE);
		await writeScenarios(forgeDir, [
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
		await writeCases(forgeDir, "ack-optional-quiz", [
			{
				id: "ack-optional-quiz-01",
				scenario: "ack-optional-quiz",
				input: { email: "x" },
				expected: { label: "acknowledgement" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeCases(forgeDir, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-02",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeSuite(forgeDir, {
			...SUITE,
			target: { ...SUITE.target, models: ["target-haiku-4-5"] },
		});
		return forgeDir;
	}

	test("writes report.md and report.json from the real fixture and prints the headline; exits 0", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], ctx)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDir, "report.json"), "utf8"),
		);
		expect(json.matched).toBe(4);
		expect(json.passRate).toBe(1);
		expect(json.cases.map((c: { case: string }) => c.case)).toEqual([
			"ack-optional-quiz-01",
			"out-of-scope-newsletter-02",
		]);
		expect(json.promptfooVersion).toBe("0.123.0");
		const md = await readFile(join(forgeDir, "report.md"), "utf8");
		expect(md).toContain("**Pass rate:** 100.0% (4 of 4 runs, 0 errored)");
		expect(md).toContain("No failing or errored case.");
		expect(out).toContain(
			"report: 4 of 4 rows matched; pass rate 100.0%; 0 failing or errored; 0 flaky; 0 judge disagreements",
		);
		expect(out).toContain(
			`report: wrote ${join(forgeDir, "report.md")} and ${join(forgeDir, "report.json")}`,
		);
	});

	test("compares the run against the estimate the person saw before running", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		const { ctx } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], ctx)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDir, "report.json"), "utf8"),
		);
		const judge = json.costs.find(
			(c: { role: string }) => c.role === "judge",
		) as { model: string; estimatedDollars: number };
		expect(judge.model).toBe("google/gemini-3.5-flash");
		// Computed from the real prices.yaml row for google/gemini-3.5-flash
		// (input 1.5, output 9 per million tokens) and the one rubric case
		// forgeMatchingFixture selects (out-of-scope-newsletter-02, whose
		// rubric text is the single character "r", 1 token): perJudgeCalls
		// is 1 target model * repeat 2 = 2; input tokens per call are the
		// label output guess (8) + the rubric (1) + JUDGE_PROMPT_OVERHEAD
		// (200) = 209, so 418 total; output tokens are 2 calls *
		// JUDGE_OUTPUT_TOKENS (174) = 348.
		expect(judge.estimatedDollars).toBe((418 * 1.5 + 348 * 9) / 1_000_000);
	});

	test("--baseline reads a previous report.json and reports what changed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.ctx)).toBe(0);
		const previous = join(cwd, "previous.json");
		const baseline = JSON.parse(
			await readFile(join(forgeDir, "report.json"), "utf8"),
		);
		// pretend the first case was failing before
		baseline.cases[0].stability = "failing";
		await writeFile(previous, JSON.stringify(baseline));
		const second = await ctxIn(cwd);
		expect(
			await run(["report", RESULTS, "--baseline", previous], second.ctx),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 1 fixed",
		);
		const md = await readFile(join(forgeDir, "report.md"), "utf8");
		expect(md).toContain("Fixed since baseline: 1.");
	});

	test("rows of a case the suite no longer selects are listed apart, not counted into the pass rate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		// The case is still on disk and still has rows in results.json, but
		// the estimate priced the run without it.
		await writeCases(forgeDir, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-02",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "rejected",
				generated_by: "t",
			},
		]);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], ctx)).toBe(0);
		const json = JSON.parse(
			await readFile(join(forgeDir, "report.json"), "utf8"),
		);
		expect(json.matched).toBe(2);
		expect(json.unmatched).toEqual([
			"row 2 (testIdx 2): target-haiku-4-5: out-of-scope-newsletter-02 (not in the current selection)",
			"row 3 (testIdx 3): target-haiku-4-5: out-of-scope-newsletter-02 (not in the current selection)",
		]);
		expect(json.cases.map((c: { case: string }) => c.case)).toEqual([
			"ack-optional-quiz-01",
		]);
		expect(out).toContain(
			"report: 2 of 4 rows matched; pass rate 100.0%; 0 failing or errored; 0 flaky; 0 judge disagreements",
		);
	});

	test("a results file whose rows match no case exits 1 and names the file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		await writeCases(forgeDir, "ack-optional-quiz", [
			{
				id: "ack-optional-quiz-09",
				scenario: "ack-optional-quiz",
				input: { email: "x" },
				expected: { label: "acknowledgement" },
				status: "approved",
				generated_by: "t",
			},
		]);
		await writeCases(forgeDir, "out-of-scope-newsletter", [
			{
				id: "out-of-scope-newsletter-09",
				scenario: "out-of-scope-newsletter",
				input: { email: "y" },
				expected: { rubric: "r" },
				status: "approved",
				generated_by: "t",
			},
		]);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], ctx)).toBe(1);
		expect(out.at(-1)).toContain(RESULTS);
		expect(out.at(-1)).toContain("forge emitted");
		expect(out.at(-1)).toContain(
			'first metadata.case seen: "ack-optional-quiz-01", 4 rows',
		);
		await expect(stat(join(forgeDir, "report.md"))).rejects.toThrow();
	});

	test("no positional argument is a usage error (exit 2) naming results.json", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report"], ctx)).toBe(2);
		expect(out.at(-1)).toContain("results.json");
	});

	test("a baseline that is not a report is a ForgeError naming the file (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const bad = join(cwd, "bad.json");
		await writeFile(bad, "{}");
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", bad], ctx)).toBe(1);
		expect(out.at(-1)).toContain(bad);
		expect(out.at(-1)).toContain("is not a forge report");
	});

	test("a baseline that is not JSON at all names the file and the problem", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const bad = join(cwd, "bad.json");
		await writeFile(bad, "{not json");
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", bad], ctx)).toBe(1);
		expect(out.at(-1)).toContain("invalid JSON");
		expect(out.at(-1)).toContain(bad);
	});

	test("a baseline file that does not exist names it (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const missing = join(cwd, "gone.json");
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", missing], ctx)).toBe(1);
		expect(out.at(-1)).toContain(missing);
		expect(out.at(-1)).toContain("baseline not found");
	});

	test("an empty --baseline is reported, not silently ignored", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await forgeMatchingFixture(cwd);
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS, "--baseline", ""], ctx)).toBe(1);
		expect(out.at(-1)).toContain("baseline not found");
	});

	test("a pending feature is refused before anything is read (exit 1)", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		await writeFeature(forgeDir, { ...FEATURE, status: "pending" });
		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["report", RESULTS], ctx)).toBe(1);
		expect(out.at(-1)).toContain("pending");
	});

	test("a baseline in the shape the previous version wrote is still accepted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.ctx)).toBe(0);
		const previous = join(cwd, "previous.json");
		const baseline = JSON.parse(
			await readFile(join(forgeDir, "report.json"), "utf8"),
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
			await run(["report", RESULTS, "--baseline", previous], second.ctx),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 1 fixed",
		);
	});

	test("report.json is readable back as its own baseline", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const forgeDir = await forgeMatchingFixture(cwd);
		const first = await ctxIn(cwd);
		expect(await run(["report", RESULTS], first.ctx)).toBe(0);
		const second = await ctxIn(cwd);
		expect(
			await run(
				["report", RESULTS, "--baseline", join(forgeDir, "report.json")],
				second.ctx,
			),
		).toBe(0);
		expect(second.out).toContain(
			"report: since baseline: 0 regressions, 0 fixed",
		);
	});
});
