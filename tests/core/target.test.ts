import { describe, expect, test } from "bun:test";
import { entryFor, httpTransform } from "../../src/core/target";

describe("entryFor", () => {
	test("an explicit entry wins; otherwise each shim kind has its default", () => {
		expect(
			entryFor({ kind: "python", models: ["m/x"], entry: "mine.py" }),
		).toBe("mine.py");
		expect(entryFor({ kind: "python", models: ["m/x"] })).toBe(
			"forge_target.py",
		);
		expect(entryFor({ kind: "javascript", models: ["m/x"] })).toBe(
			"forge_target.mjs",
		);
		expect(entryFor({ kind: "typescript", models: ["m/x"] })).toBe(
			"forge_target.ts",
		);
		expect(entryFor({ kind: "elixir", models: ["m/x"] })).toBe(
			"forge_target.exs",
		);
		expect(entryFor({ kind: "ruby", models: ["m/x"] })).toBe("forge_target.rb");
		expect(entryFor({ kind: "rust", models: ["m/x"] })).toBe("forge_target");
		expect(entryFor({ kind: "go", models: ["m/x"] })).toBe("forge_target");
	});
	test("a kind without a shim has no entry", () => {
		expect(entryFor({ kind: "exec", models: ["m/x"], command: "./run" })).toBe(
			"",
		);
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
});
