import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import { enumerateScenarios } from "../../src/core/scenarios";
import type { Feature, Scenario } from "../../src/core/schemas";
import { createLlm, type GenerateArgs, type Llm } from "../../src/llm/generate";

const FIXTURE = "tests/fixtures/scenarios-response.json";

async function llmFor(verb: string): Promise<{ llm: Llm; model: string }> {
	// The fake provider picks by verb; enumerateScenarios always uses verb "scenarios",
	// so route through a tiny adapter that rewrites the verb to the fixture key we want.
	const base = createLlm({
		forgeDir: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
	const llm: Llm = {
		generate: <T>(args: GenerateArgs<T>) => base.generate<T>({ ...args, verb }),
	};
	return { model: `fake/${FIXTURE}`, llm };
}

async function feature(): Promise<Feature> {
	return parse(
		await readFile(join(import.meta.dir, "../fixtures/feature.yaml"), "utf8"),
	);
}

describe("enumerateScenarios", () => {
	test("returns pending scenarios covering every kind", async () => {
		const { llm, model } = await llmFor("scenarios");
		const out = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			model,
			llm,
		});
		expect(out).toHaveLength(6);
		expect(new Set(out.map((s) => s.kind)).size).toBe(6);
		expect(out.every((s) => s.status === "pending")).toBe(true);
	});

	test("names the missing kinds when coverage fails", async () => {
		const { llm, model } = await llmFor("missing-kinds");
		const err = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("edge");
		expect((err as ForgeError).message).toContain("language");
		// Every failure names the item it is about; here that is the feature.
		expect((err as ForgeError).details.id).toBe("classify-email");
		expect((err as ForgeError).message).toContain("(id: classify-email)");
	});

	test("--kinds restricts coverage to the listed kinds", async () => {
		const { llm, model } = await llmFor("missing-kinds");
		const out = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			kinds: ["happy"],
			model,
			llm,
		});
		expect(out).toHaveLength(1);
	});

	test("zero scenarios is an error naming the feature, never a silent empty file", async () => {
		const { llm, model } = await llmFor("empty");
		const err = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			model,
			llm,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toBe(
			"the model returned zero scenarios (id: classify-email)",
		);
	});

	test("--more keeps reviewed scenarios untouched and makes ids unique", async () => {
		const { llm, model } = await llmFor("clashing-id");
		const existing: Scenario[] = [
			{
				id: "polite-rejection",
				kind: "happy",
				oracle: "label",
				description: "kept",
				status: "approved",
			},
		];
		const out = await enumerateScenarios({
			feature: await feature(),
			existing,
			more: 1,
			model,
			llm,
		});
		expect(out[0]).toEqual(existing[0]);
		expect(out[1]?.id).toBe("polite-rejection-2");
		expect(out[1]?.status).toBe("pending");
	});

	test("de-duplicates two generated scenarios that slugify to the same base within one batch", async () => {
		const { llm, model } = await llmFor("clashing-slugs-in-batch");
		const out = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			kinds: ["happy"],
			model,
			llm,
		});
		expect(out).toHaveLength(2);
		expect(out[0]?.id).toBe("polite-rejection");
		expect(out[1]?.id).toBe("polite-rejection-2");
	});

	test("falls back to 'scenario' when a generated id slugifies to nothing", async () => {
		const { llm, model } = await llmFor("symbols-only-id");
		const out = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			kinds: ["happy"],
			model,
			llm,
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("scenario");
	});
});
