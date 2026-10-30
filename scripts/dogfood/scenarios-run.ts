import { ForgeError } from "../../src/core/errors";
import { enumerateScenarios } from "../../src/core/scenarios";
import { Kind } from "../../src/core/schemas";
import type { Handler } from "./entry";
import { featureFrom, requiredVariable } from "./inputs";

function kindsFrom(text: string | undefined) {
	if (text === undefined || text.trim() === "") return undefined;
	return text.split(",").map((name) => {
		const parsed = Kind.safeParse(name.trim());
		if (!parsed.success)
			throw new ForgeError(
				`the kinds input names "${name.trim()}", which is not one of ${Kind.options.join(", ")}`,
			);
		return parsed.data;
	});
}

/**
 * Runs the real `enumerateScenarios` on the suite's `feature` input (and the
 * optional comma-separated `kinds`) and prints which kinds the model covered.
 * The function itself refuses an answer that misses a wanted kind, so a row
 * passes only when every wanted kind is there.
 */
export const runScenarios: Handler = async (invocation, llm) => {
	const feature = featureFrom(
		requiredVariable(invocation, "feature", "scenarios"),
	);
	const scenarios = await enumerateScenarios({
		feature,
		existing: [],
		kinds: kindsFrom(invocation.variables.kinds),
		model: invocation.model,
		llm,
	});
	return JSON.stringify({
		kinds: [...new Set(scenarios.map((scenario) => scenario.kind))].sort(),
	});
};
