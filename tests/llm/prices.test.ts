import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";
import type { Prices } from "../../src/core/schemas";
import { loadPrices, priceFor } from "../../src/llm/prices";

const table: Prices = {
	updated: "2026-09-15",
	unit: "usd_per_million_tokens",
	sources: [],
	models: {
		"anthropic/claude-haiku-4-5": { input: 1, output: 5 },
		"anthropic/claude-sonnet-5": { input: 2, output: 10 },
		"google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
	},
};

describe("loadPrices", () => {
	test("reads the repository's prices.yaml by default, and it validates", async () => {
		const p = await loadPrices();
		expect(p.unit).toBe("usd_per_million_tokens");
		expect(p.models["anthropic/claude-haiku-4-5"]).toEqual({
			input: 1,
			output: 5,
		});
	});
	test("names the file when it is missing", async () => {
		const err = await loadPrices("/nowhere/prices.yaml").catch((e: Error) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain("/nowhere/prices.yaml");
	});
	test("rejects a table that does not validate, naming the file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-prices-"));
		const f = join(dir, "prices.yaml");
		await writeFile(
			f,
			"updated: 2026-09-15\nunit: usd_per_million_tokens\nmodels: {}\n",
		);
		const err = await loadPrices(f).catch((e: Error) => e);
		expect((err as Error).message).toContain("at least one model");
		expect((err as Error).message).toContain(f);
	});
});

describe("priceFor", () => {
	test("an exact match is not approximate and is priced as itself", () => {
		expect(priceFor("google/gemini-3.5-flash", table)).toEqual({
			input: 0.3,
			output: 2.5,
			pricedAs: "google/gemini-3.5-flash",
			approximate: false,
			priced: true,
		});
	});
	test("an unknown model of a known provider is priced as the same-provider model with the longest common prefix", () => {
		expect(priceFor("anthropic/claude-haiku-4-6", table)).toEqual({
			input: 1,
			output: 5,
			pricedAs: "anthropic/claude-haiku-4-5",
			approximate: true,
			priced: true,
		});
	});
	test("an unknown provider is not priced", () => {
		expect(priceFor("ollama/llama3", table)).toEqual({
			input: 0,
			output: 0,
			pricedAs: "ollama/llama3",
			approximate: true,
			priced: false,
		});
	});
	test("prefix ties resolve to the first listed candidate (file order), so the result is deterministic", () => {
		const t: Prices = {
			...table,
			models: {
				"google/gemini-3.5-pro": { input: 1, output: 2 },
				"google/gemini-3.5-flash": { input: 3, output: 4 },
			},
		};
		expect(priceFor("google/gemini-3.5-x", t).pricedAs).toBe(
			"google/gemini-3.5-pro",
		);
	});
});
