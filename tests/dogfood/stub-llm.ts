import type { runDedupe } from "../../scripts/dogfood/dedupe-run";

export type StubLlm = Parameters<typeof runDedupe>[1];

/** An Llm that answers every request with `object`, recording the requests. */
export function llmReturning(object: unknown) {
	const calls: unknown[] = [];
	const llm: StubLlm = {
		async generate<T>(request: unknown) {
			calls.push(request);
			return {
				object: object as T,
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		},
	};
	return { llm, calls };
}
