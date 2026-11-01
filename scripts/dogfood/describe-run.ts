import { describeFeature } from "../../src/core/describe";
import type { Handler } from "./entry";
import { requiredVariable } from "./inputs";

/**
 * Runs the real `describeFeature` on a plain-language description (and the
 * optional `prompt` text) and prints the structure of the feature it drew:
 * how many inputs, what kind of output, its labels when it is a label, and
 * whether it wrote invariants.
 */
export const runDescribe: Handler = async (invocation, llm) => {
	const feature = await describeFeature({
		text: requiredVariable(invocation, "description", "describe"),
		promptText: invocation.variables.prompt,
		model: invocation.model,
		llm,
	});
	return JSON.stringify({
		input_count: feature.inputs.length,
		output_kind: feature.output.kind,
		...(feature.output.kind === "label"
			? { labels: [...(feature.output.labels ?? [])].sort() }
			: {}),
		has_invariants: feature.invariants.length > 0,
		status: feature.status,
	});
};
