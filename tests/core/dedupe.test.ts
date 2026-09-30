import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeCases } from "../../src/core/dedupe";
import type { Case } from "../../src/core/schemas";
import { createLlm, type Llm } from "../../src/llm/generate";
import { fixturePath } from "../helpers/repository";

const MODEL = `fake/${fixturePath("dedupe-response.json")}`;
const makeCase = (id: string, status: Case["status"] = "pending"): Case => ({
	id,
	scenario: "s",
	input: { email: id },
	expected: { label: "x" },
	status,
	generated_by: "t",
});

async function llm(): Promise<Llm> {
	return createLlm({
		forgeDirectory: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
}

describe("dedupeCases", () => {
	test("marks valid pairs, ignores unknown ids and self pairs, never marks reviewed cases, but a pending case may point at one", async () => {
		const cases = [
			makeCase("s-01"),
			makeCase("s-02"),
			makeCase("s-03"),
			makeCase("s-04"),
			makeCase("s-05", "approved"),
			makeCase("s-06"),
			makeCase("s-07", "edited"),
		];
		const out = await dedupeCases({ cases, model: MODEL, llm: await llm() });
		expect(out.map((deduped) => deduped.duplicate_of)).toEqual([
			undefined,
			undefined,
			"s-01",
			undefined,
			// s-05 is approved: the model paired it with s-01, but a reviewed
			// case is never marked as a duplicate itself.
			undefined,
			// s-06 is pending and points AT the reviewed s-05 — that direction
			// is allowed, so the mark stands.
			"s-05",
			// s-07 is edited: the model paired it with s-01, but a reviewed
			// case (edited, not just approved) is never marked as a duplicate.
			undefined,
		]);
		expect(out.map((deduped) => deduped.id)).toEqual([
			"s-01",
			"s-02",
			"s-03",
			"s-04",
			"s-05",
			"s-06",
			"s-07",
		]);
	});

	test("does not call the model with fewer than two cases", async () => {
		let calls = 0;
		// `generate` is generic in `Llm`, so the mock's returned object is cast
		// to the caller's own `T` rather than to `any`/`never` — this spy is
		// never called (that is what the test asserts), so the concrete shape
		// of `object` never matters.
		const spy: Llm = {
			async generate<T>() {
				calls += 1;
				return {
					object: { duplicates: [] } as T,
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
		};
		const out = await dedupeCases({
			cases: [makeCase("s-01")],
			model: "anthropic/x",
			llm: spy,
		});
		expect(calls).toBe(0);
		expect(out).toEqual([makeCase("s-01")]);
	});

	test("two cases are enough to ask: the model reads each id, input and expected, a long input on one line", async () => {
		const prompts: string[] = [];
		const recording: Llm = {
			async generate(request) {
				prompts.push(request.prompt);
				return {
					object: request.schema.parse({
						duplicates: [{ id: "s-02", duplicate_of: "s-01" }],
					}),
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
		};
		const long = Array(3)
			.fill("a long email body that runs past any line width")
			.join(" ");
		const cases = [
			{ ...makeCase("s-01"), input: { email: long } },
			makeCase("s-02"),
		];
		const out = await dedupeCases({
			cases,
			model: "anthropic/x",
			llm: recording,
		});
		expect(out.map((deduped) => deduped.duplicate_of)).toStrictEqual([
			undefined,
			"s-01",
		]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(
			[
				"<cases>",
				"- id: s-01",
				"  input:",
				`    email: ${long}`,
				"  expected:",
				"    label: x",
				"- id: s-02",
				"  input:",
				"    email: s-02",
				"  expected:",
				"    label: x",
			].join("\n"),
		);
	});
});
