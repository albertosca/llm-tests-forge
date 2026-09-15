import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeCases } from "../../src/core/dedupe";
import type { Case } from "../../src/core/schemas";
import { createLlm, type Llm } from "../../src/llm/generate";

const MODEL = "fake/tests/fixtures/dedupe-response.json";
const c = (id: string, status: Case["status"] = "pending"): Case => ({
	id,
	scenario: "s",
	input: { email: id },
	expected: { label: "x" },
	status,
	generated_by: "t",
});

async function llm(): Promise<Llm> {
	return createLlm({
		forgeDir: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
}

describe("dedupeCases", () => {
	test("marks valid pairs, ignores unknown ids and self pairs, never marks reviewed cases, but a pending case may point at one", async () => {
		const cases = [
			c("s-01"),
			c("s-02"),
			c("s-03"),
			c("s-04"),
			c("s-05", "approved"),
			c("s-06"),
			c("s-07", "edited"),
		];
		const out = await dedupeCases({ cases, model: MODEL, llm: await llm() });
		expect(out.map((x) => x.duplicate_of)).toEqual([
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
		expect(out.map((x) => x.id)).toEqual([
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
			cases: [c("s-01")],
			model: "anthropic/x",
			llm: spy,
		});
		expect(calls).toBe(0);
		expect(out).toEqual([c("s-01")]);
	});
});
