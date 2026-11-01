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
 * Runs the real `enumerateScenarios` on the suite's `feature` input and the
 * comma-separated `kinds` it must cover, and prints which of the wanted kinds
 * the model covered. The prompt asks for "at least one of each", never for
 * "only these", so extra kinds are not reported; a missing one makes the
 * function itself refuse, which is an error row.
 */
export const runScenarios: Handler = async (invocation, llm) => {
	const feature = featureFrom(
		requiredVariable(invocation, "feature", "scenarios"),
	);
	const wanted = kindsFrom(invocation.variables.kinds);
	const scenarios = await enumerateScenarios({
		feature,
		existing: [],
		kinds: wanted,
		model: invocation.model,
		llm,
	});
	// Read from what came back, so the answer can fail if the function ever stops refusing a missing kind.
	const present = new Set(scenarios.map((scenario) => scenario.kind));
	const covered = (wanted ?? Kind.options).filter((kind) => present.has(kind));
	return JSON.stringify({ covered: [...covered].sort() });
};
