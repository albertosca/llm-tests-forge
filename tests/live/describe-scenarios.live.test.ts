/**
 * One real call per verb against a live model. Off by default; run with
 * `bun run test:live` (sets FORGE_LIVE=1).
 *
 * Default model: google/gemini-3.5-flash. Override with FORGE_MODEL to
 * point at a different provider/model. GOOGLE_API_KEY must already be set
 * (most dev shells here already export it) -- a missing key fails this
 * test loudly, naming the variable; it does not silently skip.
 *
 * The Google free tier is intermittent, not simply down: the same model
 * has answered both 503 ("high demand") and 200 within minutes of each
 * other. A 503/UNAVAILABLE is retried up to 3 attempts total with a short
 * pause between them; anything else (a 429 quota error, an auth error, an
 * unknown model id, a schema failure from generateObject, or an assertion
 * failure) fails on the very first occurrence -- retrying those would hide
 * exactly the failures this test exists to catch.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CliContext } from "../../src/cli/context";
import { createContext } from "../../src/cli/context";
import { run } from "../../src/cli/main";
import { readFeature, readScenarios, writeFeature } from "../../src/core/files";

const live = process.env.FORGE_LIVE === "1";
const model = process.env.FORGE_MODEL ?? "google/gemini-3.5-flash";

const MISSING_GOOGLE_KEY =
	"GOOGLE_API_KEY is not set. Export it before running `bun run test:live` " +
	"(FORGE_LIVE=1) -- see https://ai.google.dev/gemini-api/docs/api-key.";

/** Matches only the provider's own transient-overload signal (503 /
 * UNAVAILABLE / "high demand"), never a 429 quota error, an auth failure,
 * an unknown-model error, or a schema-validation failure -- those must
 * fail immediately, not be mistaken for "the provider is busy". */
const TRANSIENT_PATTERN = /\b(503|unavailable|high demand)\b/i;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;

/**
 * Runs one forge verb, retrying only when the printed failure is the
 * provider's own transient-overload signal. Any other non-zero exit (a
 * schema failure, an auth error, a quota error, an unknown model id) fails
 * immediately with the exact printed message, so a reader can tell "the
 * provider was busy" from "the code is broken" without reading a stack
 * trace -- a genuine programming error (not caught by `run()` at all,
 * per its own classification) still propagates past this helper with its
 * real stack, unchanged.
 */
async function runRetryingTransient(
	argv: string[],
	ctx: CliContext,
	out: string[],
): Promise<void> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const code = await run(argv, ctx);
		if (code === 0) return;
		const lastLine = out.at(-1) ?? "(no output)";
		if (!TRANSIENT_PATTERN.test(lastLine))
			throw new Error(
				`\`forge ${argv[0]}\` failed with a non-transient error on attempt ${attempt}/${MAX_ATTEMPTS} (not retried -- this looks like a real defect, not the provider being busy): ${lastLine}`,
			);
		if (attempt === MAX_ATTEMPTS)
			throw new Error(
				`\`forge ${argv[0]}\` was still a transient provider-overload failure after ${MAX_ATTEMPTS} attempts (the provider was busy, not the code): ${lastLine}`,
			);
		await sleep(RETRY_DELAY_MS);
	}
}

describe.skipIf(!live)(
	"live: describe and scenarios against a real model",
	() => {
		test("produces a pending feature and six kinds of scenarios", async () => {
			// A missing key must fail this test with a message naming the
			// variable -- not surface as a provider auth error deep inside
			// generateObject, and not be silently skipped (only FORGE_LIVE
			// gates skipping; the key is a hard precondition once live is on).
			if (model.startsWith("google/") && !process.env.GOOGLE_API_KEY)
				throw new Error(MISSING_GOOGLE_KEY);

			const cwd = await mkdtemp(join(tmpdir(), "forge-live-"));
			const ctx = createContext({ cwd, model, stdin: async () => "" });
			const out: string[] = [];
			ctx.stdout = (l) => out.push(l);

			await runRetryingTransient(
				[
					"describe",
					"The bot receives one hiring-process email (from, subject, body) and classifies it as rejection, acknowledgement, interview, screening, offer, info_request or unrelated, answering JSON only. Automated confirmations are acknowledgement, never screening.",
				],
				ctx,
				out,
			);
			const feature = await readFeature(join(cwd, ".forge"));
			expect(feature.output.labels).toContain("acknowledgement");
			await writeFeature(join(cwd, ".forge"), {
				...feature,
				status: "approved",
			});

			await runRetryingTransient(["scenarios"], ctx, out);
			const scenarios = await readScenarios(join(cwd, ".forge"));
			expect(new Set(scenarios.map((s) => s.kind)).size).toBe(6);
			console.log(out.join("\n"));
		}, 300_000);
	},
);
