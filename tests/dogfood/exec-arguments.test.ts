import { describe, expect, test } from "bun:test";
import { parseExecArguments } from "../../scripts/dogfood/exec-arguments";

const options = JSON.stringify({ config: { model: "fake/x" } });

describe("parseExecArguments", () => {
	test("takes the model from config.model and the case inputs from vars, dropping promptfoo's own __ keys and non-strings", () => {
		const context = JSON.stringify({
			vars: { cases: "- id: a", __evalId: "e1", count: 3 },
		});
		expect(parseExecArguments(["prompt", options, context])).toEqual({
			model: "fake/x",
			variables: { cases: "- id: a" },
		});
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
