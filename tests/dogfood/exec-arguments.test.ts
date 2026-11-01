import { describe, expect, test } from "bun:test";
import { parseExecArguments } from "../../scripts/dogfood/exec-arguments";

const options = JSON.stringify({ config: { model: "fake/x" } });

describe("parseExecArguments", () => {
	test("takes the model from config.model and the case inputs from vars, dropping promptfoo's own __ keys", () => {
		const context = JSON.stringify({
			vars: { cases: "- id: a", __evalId: "e1", __other: 3 },
		});
		expect(parseExecArguments(["prompt", options, context])).toEqual({
			model: "fake/x",
			variables: { cases: "- id: a" },
		});
	});
	test("an input that is not text is refused, naming it and its type, instead of being dropped", () => {
		for (const [value, type] of [
			[5, "number"],
			[null, "null"],
			[["a"], "object"],
			[true, "boolean"],
		] as const)
			expect(() =>
				parseExecArguments([
					"p",
					options,
					JSON.stringify({ vars: { description: value } }),
				]),
			).toThrow(`the \`description\` input must be text, got ${type}`);
	});
	test("a context without vars gives no variables", () => {
		expect(parseExecArguments(["p", options, "{}"]).variables).toEqual({});
	});
	test("refuses fewer than three arguments", () => {
		expect(() => parseExecArguments(["p", options])).toThrow("three arguments");
	});
	test("refuses an argument that is not JSON, or not an object", () => {
		expect(() => parseExecArguments(["p", "{oops", "{}"])).toThrow(
			"options argument is not JSON",
		);
		expect(() => parseExecArguments(["p", options, "[]"])).toThrow(
			"context argument is not a JSON object",
		);
	});
	test("refuses options with no model", () => {
		for (const text of ["{}", '{"config":{}}', '{"config":{"model":""}}']) {
			expect(() => parseExecArguments(["p", text, "{}"])).toThrow(
				"no config.model",
			);
		}
	});
});
