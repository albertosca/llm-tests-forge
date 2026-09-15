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
 * exactly the failures this test exists to catch. The classify-and-retry
 * logic itself lives in `./retry.ts`, not here, so it has its own offline,
 * network-free unit tests in `retry.test.ts` instead of being untested
 * dead ground behind `describe.skipIf`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../src/cli/context";
import { run } from "../../src/cli/main";
import { readFeature, readScenarios, writeFeature } from "../../src/core/files";
import { DEFAULT_RETRY_CONFIG, retryTransient } from "./retry";

const live = process.env.FORGE_LIVE === "1";
const model = process.env.FORGE_MODEL ?? "google/gemini-3.5-flash";

const MISSING_GOOGLE_KEY =
	"GOOGLE_API_KEY is not set. Export it before running `bun run test:live` " +
	"(FORGE_LIVE=1) -- see https://ai.google.dev/gemini-api/docs/api-key.";

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

			await retryTransient(
				"`forge describe`",
				async () => ({
					code: await run(
						[
							"describe",
							"The bot receives one hiring-process email (from, subject, body) and classifies it as rejection, acknowledgement, interview, screening, offer, info_request or unrelated, answering JSON only. Automated confirmations are acknowledgement, never screening.",
						],
						ctx,
					),
					message: out.at(-1) ?? "(no output)",
				}),
				DEFAULT_RETRY_CONFIG,
			);
			const feature = await readFeature(join(cwd, ".forge"));
			expect(feature.output.labels).toContain("acknowledgement");
			await writeFeature(join(cwd, ".forge"), {
				...feature,
				status: "approved",
			});

			await retryTransient(
				"`forge scenarios`",
				async () => ({
					code: await run(["scenarios"], ctx),
					message: out.at(-1) ?? "(no output)",
				}),
				DEFAULT_RETRY_CONFIG,
			);
			const scenarios = await readScenarios(join(cwd, ".forge"));
			expect(new Set(scenarios.map((s) => s.kind)).size).toBe(6);
			console.log(out.join("\n"));
		}, 300_000);
	},
);
