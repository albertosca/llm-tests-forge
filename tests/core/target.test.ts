import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import {
	EMPTY_RESPONSE_REFUSAL,
	httpTransform,
	RESPONSE_FUNCTION_REFUSAL,
	shimTarget,
} from "../../src/core/target";

describe("shimTarget", () => {
	test("an explicit entry wins; otherwise each shim kind has its default", () => {
		expect(
			shimTarget({ kind: "python", models: ["m/x"], entry: "mine.py" }),
		).toEqual({ kind: "python", entry: "mine.py" });
		expect(shimTarget({ kind: "python", models: ["m/x"] })).toEqual({
			kind: "python",
			entry: "forge_target.py",
		});
		expect(shimTarget({ kind: "javascript", models: ["m/x"] })).toEqual({
			kind: "javascript",
			entry: "forge_target.mjs",
		});
		expect(shimTarget({ kind: "typescript", models: ["m/x"] })).toEqual({
			kind: "typescript",
			entry: "forge_target.ts",
		});
		expect(shimTarget({ kind: "elixir", models: ["m/x"] })).toEqual({
			kind: "elixir",
			entry: "forge_target.exs",
		});
		expect(shimTarget({ kind: "ruby", models: ["m/x"] })).toEqual({
			kind: "ruby",
			entry: "forge_target.rb",
		});
		expect(shimTarget({ kind: "rust", models: ["m/x"] })).toEqual({
			kind: "rust",
			entry: "forge_target",
		});
		expect(shimTarget({ kind: "go", models: ["m/x"] })).toEqual({
			kind: "go",
			entry: "forge_target",
		});
	});
	test("exec and http have no shim, even when the suite names an entry", () => {
		expect(
			shimTarget({ kind: "exec", models: ["m/x"], command: "./run" }),
		).toBeNull();
		expect(
			shimTarget({ kind: "http", models: ["m/x"], url: "http://x" }),
		).toBeNull();
		expect(
			shimTarget({
				kind: "http",
				models: ["m/x"],
				url: "http://x",
				entry: "ignored.py",
			}),
		).toBeNull();
	});
});

describe("httpTransform", () => {
	test("turns the chosen part of the response into text, with json as the default", () => {
		expect(httpTransform(undefined)).toBe(
			'typeof (json) === "string" ? (json) : JSON.stringify(json)',
		);
		expect(httpTransform("json.result")).toBe(
			'typeof (json.result) === "string" ? (json.result) : JSON.stringify(json.result)',
		);
	});
	test("an expression holding => is refused, as promptfoo would call it as a function", () => {
		expect(() => httpTransform("(json) => json.a")).toThrow(ForgeError);
		expect(() => httpTransform("json.items.map(x=>x)")).toThrow(
			RESPONSE_FUNCTION_REFUSAL,
		);
		expect(RESPONSE_FUNCTION_REFUSAL).toStartWith(
			"target.response must be an expression over json",
		);
	});
	test("an empty or whitespace-only expression is refused, as the schema refuses it", () => {
		expect(EMPTY_RESPONSE_REFUSAL).toBe("target.response is empty");
		for (const response of ["", "   ", "\t\n"]) {
			expect(() => httpTransform(response)).toThrow(ForgeError);
			expect(() => httpTransform(response)).toThrow(EMPTY_RESPONSE_REFUSAL);
		}
	});
});
