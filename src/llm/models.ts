import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { ForgeError } from "../core/errors";

// `ai`'s own `LanguageModel` type is a union that also admits a bare model-id
// string (its global provider registry shorthand, which this project never
// uses). Deriving the concrete provider model type from the factories we
// already depend on keeps `.modelId`/`.provider` access type-safe without
// importing the `@ai-sdk/provider` package directly (it is only a transitive
// dependency here, never declared in package.json).
export type ResolvedModel = ReturnType<ReturnType<typeof createAnthropic>>;

export const PROVIDERS = [
	"anthropic",
	"google",
	"openai",
	"ollama",
	"fake",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ModelSpec {
	provider: Provider;
	model: string;
}

export function parseModelSpec(spec: string): ModelSpec {
	const slash = spec.indexOf("/");
	if (slash <= 0)
		throw new ForgeError(`model spec must be provider/model, got "${spec}"`);
	const provider = spec.slice(0, slash);
	const model = spec.slice(slash + 1);
	if (!(PROVIDERS as readonly string[]).includes(provider)) {
		throw new ForgeError(
			`unknown provider "${provider}" in "${spec}"; known: ${PROVIDERS.join(", ")}`,
		);
	}
	return { provider: provider as Provider, model };
}

function requireKey(
	env: Record<string, string | undefined>,
	name: string,
	spec: string,
): string {
	const value = env[name];
	if (!value) throw new ForgeError(`${name} is not set; needed for "${spec}"`);
	return value;
}

export function resolveModel(
	spec: string,
	env: Record<string, string | undefined> = process.env,
): ResolvedModel {
	const { provider, model } = parseModelSpec(spec);
	switch (provider) {
		case "anthropic":
			return createAnthropic({
				apiKey: requireKey(env, "ANTHROPIC_API_KEY", spec),
			})(model);
		case "google":
			return createGoogleGenerativeAI({
				apiKey: requireKey(env, "GOOGLE_API_KEY", spec),
			})(model);
		case "openai":
			return createOpenAI({ apiKey: requireKey(env, "OPENAI_API_KEY", spec) })(
				model,
			);
		case "ollama":
			// Ollama's OpenAI-compatible endpoint; not exercised outside tests/live (see plan header).
			return createOpenAI({
				apiKey: "ollama",
				baseURL: "http://localhost:11434/v1",
			})(model);
		case "fake":
			throw new ForgeError(
				`"fake/" models are handled by createLlm, not resolveModel ("${spec}")`,
			);
	}
}
