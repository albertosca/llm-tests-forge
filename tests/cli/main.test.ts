import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext } from "../../src/cli/context";
import { modelFlag, run } from "../../src/cli/main";
import { readCases, readFeature, readScenarios } from "../../src/core/files";

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

	test("missing model is a ForgeError naming the flag", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const out: string[] = [];
		const ctx = createContext({ cwd, env: {}, stdin: async () => "" });
		ctx.stdout = (l) => out.push(l);
		expect(await run(["describe", "x"], ctx)).toBe(1);
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
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped",
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
		expect(out.at(-1)).toBe(
			"review: 1 approved, 0 rejected, 0 edited, 1 skipped",
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
		).toBe(1);
		expect(out.at(-1)).toContain('"bogus"');
		expect(out.at(-1)).toContain("happy");
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
	});

	test("refuses when no scenario is approved and none was named", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		await withPendingScenarios(cwd); // scenarios exist but all remain pending

		const { ctx, out } = await ctxIn(cwd);
		expect(await run(["cases"], ctx)).toBe(1);
		expect(out.at(-1)).toContain("no approved scenario");
	});
});

describe("import: missing file", () => {
	test("fails cleanly, naming the file, when the JSONL path does not exist", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx: describeCtx } = await ctxIn(cwd);
		expect(await run(["describe", "text"], describeCtx)).toBe(0);

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
		expect(await run(["import", jsonl, "--oracle", "bogus"], ctx)).toBe(1);
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

	test("an error that is neither a ForgeError nor a parseArgs TypeError propagates instead of being swallowed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-cli-"));
		const { ctx } = await ctxIn(cwd);
		let err: unknown;
		try {
			await run(
				["describe", "text", "--prompt-file", join(cwd, "missing-prompt.md")],
				ctx,
			);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(TypeError);
		expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
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
