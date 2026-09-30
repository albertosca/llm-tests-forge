import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import { enumerateScenarios } from "../../src/core/scenarios";
import type { Feature, Scenario } from "../../src/core/schemas";
import { createLlm, type GenerateArgs, type Llm } from "../../src/llm/generate";
import { fixturePath } from "../helpers/repository";

const FIXTURE = fixturePath("scenarios-response.json");

async function llmFor(verb: string): Promise<{ llm: Llm; model: string }> {
	// The fake provider picks by verb; enumerateScenarios always uses verb "scenarios",
	// so route through a tiny adapter that rewrites the verb to the fixture key we want.
	const base = createLlm({
		forgeDirectory: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
	const llm: Llm = {
		generate: <T>(request: GenerateArgs<T>) =>
			base.generate<T>({ ...request, verb }),
	};
	return { model: `fake/${FIXTURE}`, llm };
}

async function feature(): Promise<Feature> {
	return parse(
		await readFile(join(import.meta.dir, "../fixtures/feature.yaml"), "utf8"),
	);
}

/**
 * An Llm that records what it was asked and answers with `response`, parsed
 * by the caller's own schema: what the model is told is the behaviour under
 * test here, and the fake provider never shows the prompt.
 */
function recordingLlm(response: unknown): {
	llm: Llm;
	requests: { prompt: string; verb: string }[];
} {
	const requests: { prompt: string; verb: string }[] = [];
	const llm: Llm = {
		async generate<T>(request: GenerateArgs<T>) {
			requests.push({ prompt: request.prompt, verb: request.verb });
			return {
				object: request.schema.parse(response),
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		},
	};
	return { llm, requests };
}

const LONG_SENTENCE =
	"Classify a hiring-process email received by a job candidate, whichever stage of the process it comes from and whoever sent it";

describe("enumerateScenarios, as the model is asked", () => {
	const everyKind = {
		scenarios: [
			"happy",
			"edge",
			"ambiguous",
			"out_of_scope",
			"adversarial",
			"language",
		].map((kind) => ({
			id: `a-${kind}`,
			kind,
			oracle: "label",
			description: "d",
		})),
	};

	test("a first run asks for twelve scenarios with one of each kind, quotes the feature as written, and says none exist yet", async () => {
		const { llm, requests } = recordingLlm(everyKind);
		await enumerateScenarios({
			feature: { ...(await feature()), purpose: LONG_SENTENCE },
			existing: [],
			model: "anthropic/x",
			llm,
		});
		expect(requests).toHaveLength(1);
		const prompt = requests[0]?.prompt ?? "";
		expect(prompt).toContain(
			"Produce 12 scenarios, with at least one of each kind: happy, edge, ambiguous, out_of_scope, adversarial, language. Each scenario has:",
		);
		expect(prompt).toContain(`purpose: ${LONG_SENTENCE}\n`);
		expect(prompt).toContain("<existing>\n(none)\n</existing>");
		// The verb names the call's usage line and its failure file.
		expect(requests[0]?.verb).toBe("scenarios");
	});

	test("--more asks for that many with no coverage demand, and lists each existing scenario by id, kind and description", async () => {
		const { llm, requests } = recordingLlm({
			scenarios: [
				{ id: "new-one", kind: "edge", oracle: "label", description: "d" },
			],
		});
		await enumerateScenarios({
			feature: await feature(),
			existing: [
				{
					id: "polite-rejection",
					kind: "happy",
					oracle: "label",
					description: LONG_SENTENCE,
					status: "approved",
				},
			],
			more: 3,
			model: "anthropic/x",
			llm,
		});
		const prompt = requests[0]?.prompt ?? "";
		expect(prompt).toContain("Produce 3 scenarios. Each scenario has:");
		expect(prompt).toContain(
			`<existing>\n- id: polite-rejection\n  kind: happy\n  description: ${LONG_SENTENCE}\n\n</existing>`,
		);
	});

	test("three generated scenarios that slugify alike get the base id, then -2, then -3", async () => {
		const { llm } = recordingLlm({
			scenarios: [
				"Polite rejection",
				"polite rejection!",
				"POLITE-REJECTION",
			].map((id) => ({ id, kind: "happy", oracle: "label", description: "d" })),
		});
		const out = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			kinds: ["happy"],
			model: "anthropic/x",
			llm,
		});
		expect(out.map((scenario) => scenario.id)).toStrictEqual([
			"polite-rejection",
			"polite-rejection-2",
			"polite-rejection-3",
		]);
	});
});

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
		expect(new Set(out.map((scenario) => scenario.kind)).size).toBe(6);
		expect(out.every((scenario) => scenario.status === "pending")).toBe(true);
	});

	test("names the missing kinds when coverage fails", async () => {
		const { llm, model } = await llmFor("missing-kinds");
		const failure = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("edge");
		expect((failure as ForgeError).message).toContain("language");
		// Every failure names the item it is about; here that is the feature.
		expect((failure as ForgeError).details.id).toBe("classify-email");
		expect((failure as ForgeError).message).toBe(
			"generated scenarios miss these kinds: edge, ambiguous, out_of_scope, adversarial, language; rerun, or restrict with --kinds (id: classify-email)",
		);
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
		const failure = await enumerateScenarios({
			feature: await feature(),
			existing: [],
			model,
			llm,
		}).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toBe(
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
