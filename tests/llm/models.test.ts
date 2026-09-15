import { describe, expect, test } from "bun:test";
import { parseModelSpec, resolveModel } from "../../src/llm/models";

describe("parseModelSpec", () => {
	test("splits provider and model on the first slash", () => {
		expect(parseModelSpec("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			model: "claude-haiku-4-5",
		});
		expect(parseModelSpec("fake/tests/fixtures/fake-responses.json")).toEqual({
			provider: "fake",
			model: "tests/fixtures/fake-responses.json",
		});
	});
	test("rejects unknown providers and missing slash", () => {
		expect(() => parseModelSpec("mistral/x")).toThrow(
			'unknown provider "mistral"',
		);
		expect(() => parseModelSpec("claude-haiku-4-5")).toThrow(
			"must be provider/model",
		);
	});
});

describe("resolveModel", () => {
	test("builds a real provider model when the key is present", () => {
		const m = resolveModel("anthropic/claude-haiku-4-5", {
			ANTHROPIC_API_KEY: "sk-test",
		});
		expect(m.modelId).toBe("claude-haiku-4-5");
		expect(m.provider).toContain("anthropic");
	});
	test("names the missing environment variable", () => {
		expect(() => resolveModel("google/gemini-3.5-flash", {})).toThrow(
			"GOOGLE_API_KEY",
		);
		expect(() => resolveModel("openai/gpt-5-mini", {})).toThrow(
			"OPENAI_API_KEY",
		);
	});
	test("ollama needs no key", () => {
		const m = resolveModel("ollama/llama3.2", {});
		expect(m.modelId).toBe("llama3.2");
	});
	test("rejects fake specs — those are handled by createLlm, not resolveModel", () => {
		expect(() =>
			resolveModel("fake/tests/fixtures/fake-responses.json", {}),
		).toThrow("handled by createLlm, not resolveModel");
	});
});
