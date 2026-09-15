import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../src/cli/context";
import { run } from "../../src/cli/main";
import { readFeature, readScenarios, writeFeature } from "../../src/core/files";

const live = process.env.FORGE_LIVE === "1";
const model = process.env.FORGE_MODEL ?? "google/gemini-3.5-flash";

describe.skipIf(!live)(
	"live: describe and scenarios against a real model",
	() => {
		test("produces a pending feature and six kinds of scenarios", async () => {
			const cwd = await mkdtemp(join(tmpdir(), "forge-live-"));
			const ctx = createContext({ cwd, model, stdin: async () => "" });
			const out: string[] = [];
			ctx.stdout = (l) => out.push(l);
			expect(
				await run(
					[
						"describe",
						"The bot receives one hiring-process email (from, subject, body) and classifies it as rejection, acknowledgement, interview, screening, offer, info_request or unrelated, answering JSON only. Automated confirmations are acknowledgement, never screening.",
					],
					ctx,
				),
			).toBe(0);
			const feature = await readFeature(join(cwd, ".forge"));
			expect(feature.output.labels).toContain("acknowledgement");
			await writeFeature(join(cwd, ".forge"), {
				...feature,
				status: "approved",
			});
			expect(await run(["scenarios"], ctx)).toBe(0);
			const scenarios = await readScenarios(join(cwd, ".forge"));
			expect(new Set(scenarios.map((s) => s.kind)).size).toBe(6);
			console.log(out.join("\n"));
		}, 120_000);
	},
);
