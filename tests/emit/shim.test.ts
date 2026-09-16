import { describe, expect, test } from "bun:test";
import type { Feature } from "../../src/core/schemas";
import { shimSource } from "../../src/emit/shim";

const feature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [
		{ name: "email", kind: "text" },
		{ name: "stage", kind: "text" },
	],
	output: { kind: "label", labels: ["a"] },
	invariants: [],
	status: "approved",
};

describe("shimSource", () => {
	test("fills the feature id and the input names, keeps the call_api signature promptfoo expects, and returns the usage slot", async () => {
		const src = await shimSource(feature);
		expect(src).toContain("async def call_api(prompt, options, context):");
		expect(src).toContain('INPUTS = ["email", "stage"]');
		expect(src).toContain("# Feature: classify-email");
		expect(src).toContain('model = (options.get("config") or {}).get("model")');
		expect(src).toContain('"tokenUsage"');
	});
	test("no placeholder is left unfilled", async () => {
		expect(await shimSource(feature)).not.toContain("{{");
	});
});
