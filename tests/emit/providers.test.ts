import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import {
	fromPromptfooProvider,
	toPromptfooProvider,
} from "../../src/emit/providers";

describe("toPromptfooProvider / fromPromptfooProvider", () => {
	const pairs: [string, string][] = [
		["anthropic/claude-haiku-4-5", "anthropic:messages:claude-haiku-4-5"],
		["google/gemini-3.5-flash", "google:gemini-3.5-flash"],
		["openai/gpt-5", "openai:chat:gpt-5"],
		["ollama/llama3", "ollama:chat:llama3"],
	];
	for (const [forge, promptfooId] of pairs) {
		test(`${forge} <-> ${promptfooId}`, () => {
			expect(toPromptfooProvider(forge)).toBe(promptfooId);
			expect(fromPromptfooProvider(promptfooId)).toBe(forge);
		});
	}
	test("an unknown provider is a ForgeError naming the model and the known providers", () => {
		expect(() => toPromptfooProvider("mistral/x")).toThrow(ForgeError);
		expect(() => toPromptfooProvider("mistral/x")).toThrow('"mistral/x"');
		try {
			toPromptfooProvider("mistral/x");
			throw new Error("expected a ForgeError, but nothing was thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ForgeError);
			expect((error as ForgeError).details).toEqual({ id: "mistral/x" });
			expect((error as ForgeError).reason).toBe(
				'cannot emit a promptfoo provider for "mistral/x"; known: anthropic, google, openai, ollama',
			);
		}
	});
	test("a model with no slash is refused even when it starts like a provider", () => {
		expect(() => toPromptfooProvider("openai")).toThrow(ForgeError);
		expect(() => toPromptfooProvider("openaiX")).toThrow(
			'cannot emit a promptfoo provider for "openaiX"',
		);
		expect(() => toPromptfooProvider("/gpt-5")).toThrow(ForgeError);
	});
	test("a model id with a slash inside keeps it (fake/ is refused, not mangled)", () => {
		expect(() => toPromptfooProvider("fake/tests/fixtures/x.json")).toThrow(
			ForgeError,
		);
	});
	test("the inverse returns undefined for shapes it does not know", () => {
		expect(fromPromptfooProvider("file://forge_target.py")).toBeUndefined();
		expect(fromPromptfooProvider("anthropic:completion:x")).toBeUndefined();
	});
});
