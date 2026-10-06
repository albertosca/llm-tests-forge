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
	test("the default table parses and prices a known model (that it is embedded in the binary is proved by the binary test)", async () => {
		const prices = await loadPrices();
		expect(prices.unit).toBe("usd_per_million_tokens");
		expect(prices.models["anthropic/claude-haiku-4-5"]).toEqual({
			input: 1,
			output: 5,
		});
		expect(priceFor("anthropic/claude-haiku-4-5", prices)).toMatchObject({
			input: 1,
			output: 5,
			priced: true,
			approximate: false,
		});
	});
	test("names the file when it is missing", async () => {
		const error = await loadPrices("/nowhere/prices.yaml").catch(
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(ForgeError);
		expect((error as Error).message).toContain("/nowhere/prices.yaml");
	});
	test("rejects a table that does not validate, naming the file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-prices-"));
		const file = join(directory, "prices.yaml");
		await writeFile(
			file,
			"updated: 2026-09-15\nunit: usd_per_million_tokens\nmodels: {}\n",
		);
		const error = await loadPrices(file).catch((caught: Error) => caught);
		expect((error as Error).message).toContain("at least one model");
		expect((error as Error).message).toContain(file);
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
	test("the closest row wins wherever it is listed, and a row that only shares the provider loses to a closer one", () => {
		expect(priceFor("anthropic/claude-sonnet-6", table)).toEqual({
			input: 2,
			output: 10,
			pricedAs: "anthropic/claude-sonnet-5",
			approximate: true,
			priced: true,
		});
		// The longest row is a prefix of the model, and the model a prefix of another row.
		expect(priceFor("anthropic/claude-haiku-4-5-latest", table).pricedAs).toBe(
			"anthropic/claude-haiku-4-5",
		);
		expect(priceFor("anthropic/claude-h", table).pricedAs).toBe(
			"anthropic/claude-haiku-4-5",
		);
	});
	test("a model with no provider part is priced against the rows of the provider it spells", () => {
		expect(priceFor("anthropic", table)).toMatchObject({
			pricedAs: "anthropic/claude-haiku-4-5",
			approximate: true,
			priced: true,
		});
		expect(priceFor("anthropi", table).priced).toBe(false);
	});
	test("a provider whose name only starts like a listed one is not priced from it", () => {
		expect(priceFor("anthropic-labs/claude-x", table).priced).toBe(false);
		expect(priceFor("googlex/gemini", table).priced).toBe(false);
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
		const tiedTable: Prices = {
			...table,
			models: {
				"google/gemini-3.5-pro": { input: 1, output: 2 },
				"google/gemini-3.5-flash": { input: 3, output: 4 },
			},
		};
		expect(priceFor("google/gemini-3.5-x", tiedTable).pricedAs).toBe(
			"google/gemini-3.5-pro",
		);
	});
});
