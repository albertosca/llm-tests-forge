import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped, 1 still pending",
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
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped, 5 still pending",
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

	test("a renamed scenario is written back under its new id, and the old id is gone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await pendingScenarios(cwd);
		const editor = await editorReplacing(
			cwd,
			"id: polite-rejection",
			"id: polite-rejection-fixed",
		);

		const { ctx, out } = await ctxIn(cwd, ["edit"]);
		await withEditor(editor, async () => {
			expect(await run(["review", "--only", "scenarios"], ctx)).toBe(0);
		});

		const scenarios = await readScenarios(join(cwd, ".forge"));
		expect(scenarios.map((s) => [s.id, s.status])).toEqual([
			["polite-rejection-fixed", "edited"],
			["huge-signature", "pending"],
			["ack-quiz", "pending"],
			["newsletter", "pending"],
			["injection", "pending"],
			["portuguese", "pending"],
		]);
		expect(out.at(-1)).toBe(
			"review: 0 approved, 0 rejected, 1 edited, 5 skipped, 5 still pending",
		);
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
			"review: 0 approved, 0 rejected, 1 edited, 1 skipped, 1 still pending",
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
			"review: 0 approved, 0 rejected, 0 edited, 2 skipped, 2 still pending",
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
			"review: 0 approved, 0 rejected, 0 edited, 1 skipped, 1 still pending",
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
			"review: 1 approved, 0 rejected, 0 edited, 0 skipped, 0 still pending",
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

	test("renaming a scenario onto a sibling's id is refused, and both scenarios survive", async () => {
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

		expect(out).toContain(
			'cannot apply: id "huge-signature" is already used by another item in the same file; pick an id nothing else uses (id: polite-rejection)',
		);
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
			"review: 0 approved, 0 rejected, 1 edited, 0 skipped, 0 still pending",
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
			"estimate: 1 pending item excluded; run `forge review` to include it:",
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
			"estimate: 2 pending items excluded; run `forge review` to include them:",
			`  case polite-rejection-01 is pending (${join(forgeDir, "cases", "polite-rejection.yaml")})`,
			`  case vague-rubric-01 is pending (${join(forgeDir, "cases", "vague-rubric.yaml")})`,
		]);
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
