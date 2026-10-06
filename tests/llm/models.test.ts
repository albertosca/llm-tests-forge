import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import {
	parseModelSpec,
	type ResolvedModel,
	resolveModel,
} from "../../src/llm/models";

/**
 * What a model sends, caught by a stand-in for `fetch` that answers 500: no
 * request leaves the machine, and the key, the endpoint and the headers the
 * model would have used are the ones the stand-in sees.
 */
async function requestSentBy(
	model: ResolvedModel,
): Promise<{ url: string; headers: Record<string, string> }> {
	const original = globalThis.fetch;
	const seen: { url: string; headers: Record<string, string> }[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				headers: Object.fromEntries(new Headers(init?.headers)),
			});
			return new Response("{}", { status: 500 });
		},
		{ preconnect: original.preconnect },
	);
	try {
		await Promise.resolve(
			model.doGenerate({
				prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		).catch(() => undefined);
	} finally {
		globalThis.fetch = original;
	}
	const [request] = seen;
	if (request === undefined) throw new Error("the model sent no request");
	return request;
}

function refusalOf(action: () => unknown): ForgeError {
	try {
		action();
	} catch (error) {
		if (error instanceof ForgeError) return error;
		throw error;
	}
	throw new Error("expected a ForgeError, but nothing was thrown");
}

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
	test("a spec that starts with the slash has no provider, and says so rather than naming an empty one", () => {
		expect(refusalOf(() => parseModelSpec("/gpt-5")).message).toBe(
			'model spec must be provider/model, got "/gpt-5"',
		);
	});
	test("an unknown provider is refused with the providers that are known", () => {
		expect(refusalOf(() => parseModelSpec("mistral/x")).message).toBe(
			'unknown provider "mistral" in "mistral/x"; known: anthropic, google, openai, ollama, fake',
		);
	});
});

describe("resolveModel", () => {
	test("builds a real provider model when the key is present", () => {
		const model = resolveModel("anthropic/claude-haiku-4-5", {
			ANTHROPIC_API_KEY: "sk-test",
		});
		expect(model.modelId).toBe("claude-haiku-4-5");
		expect(model.provider).toContain("anthropic");
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
		const model = resolveModel("ollama/llama3.2", {});
		expect(model.modelId).toBe("llama3.2");
	});
	test("rejects fake specs — those are handled by createLlm, not resolveModel", () => {
		expect(() =>
			resolveModel("fake/tests/fixtures/fake-responses.json", {}),
		).toThrow("handled by createLlm, not resolveModel");
	});
	test("each real provider sends the key it was given, to its own endpoint", async () => {
		const anthropic = await requestSentBy(
			resolveModel("anthropic/claude-haiku-4-5", {
				ANTHROPIC_API_KEY: "sk-anthropic-test",
			}),
		);
		expect(anthropic.url).toStartWith("https://api.anthropic.com/");
		expect(anthropic.headers["x-api-key"]).toBe("sk-anthropic-test");
		const google = await requestSentBy(
			resolveModel("google/gemini-3.5-flash", {
				GOOGLE_API_KEY: "sk-google-test",
			}),
		);
		expect(google.url).toStartWith(
			"https://generativelanguage.googleapis.com/",
		);
		expect(google.headers["x-goog-api-key"]).toBe("sk-google-test");
		const openai = await requestSentBy(
			resolveModel("openai/gpt-5-mini", { OPENAI_API_KEY: "sk-openai-test" }),
		);
		expect(openai.url).toStartWith("https://api.openai.com/");
		expect(openai.headers.authorization).toBe("Bearer sk-openai-test");
	});
	test("ollama goes to the local OpenAI-compatible endpoint with a placeholder key, whatever the environment holds", async () => {
		const ollama = await requestSentBy(
			resolveModel("ollama/llama3.2", {
				OPENAI_API_KEY: "sk-must-not-be-sent",
			}),
		);
		expect(ollama.url).toStartWith("http://localhost:11434/v1/");
		expect(ollama.headers.authorization).toBe("Bearer ollama");
	});
	test("a missing key names the variable and the model that needed it", () => {
		expect(
			refusalOf(() => resolveModel("anthropic/claude-haiku-4-5", {})).message,
		).toBe(
			'ANTHROPIC_API_KEY is not set; needed for "anthropic/claude-haiku-4-5"',
		);
	});
});
