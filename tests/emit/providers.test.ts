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
	for (const [forge, pf] of pairs) {
		test(`${forge} <-> ${pf}`, () => {
			expect(toPromptfooProvider(forge)).toBe(pf);
			expect(fromPromptfooProvider(pf)).toBe(forge);
		});
	}
	test("an unknown provider is a ForgeError naming the model", () => {
		expect(() => toPromptfooProvider("mistral/x")).toThrow(ForgeError);
		expect(() => toPromptfooProvider("mistral/x")).toThrow('"mistral/x"');
		try {
			toPromptfooProvider("mistral/x");
		} catch (e) {
			expect((e as ForgeError).details).toEqual({ id: "mistral/x" });
		}
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
