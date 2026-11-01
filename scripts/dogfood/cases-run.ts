import { generateCases } from "../../src/core/cases";
import { ForgeError } from "../../src/core/errors";
import type { Handler } from "./entry";
import { featureFrom, requiredVariable, scenarioFrom } from "./inputs";

function countFrom(text: string): number {
	const count = Number(text);
	if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(count))
		throw new ForgeError(
			`the n input must be a positive integer, got "${text}"`,
		);
	return count;
}

/**
 * Runs the real `generateCases` for one scenario and prints the shape of what
 * came back: at least one usable case, no more than asked for, the input names
 * every case carries, and which kind of expected answer they hold.
 */
export const runCases: Handler = async (invocation, llm) => {
	const feature = featureFrom(requiredVariable(invocation, "feature", "cases"));
	const scenario = scenarioFrom(
		requiredVariable(invocation, "scenario", "cases"),
	);
	const count = countFrom(requiredVariable(invocation, "n", "cases"));
	const cases = await generateCases({
		feature,
		scenario,
		existing: [],
		n: count,
		model: invocation.model,
		llm,
	});
	return JSON.stringify({
		within_n: cases.length <= count,
		input_names: [
			...new Set(cases.flatMap((generated) => Object.keys(generated.input))),
		].sort(),
		expected_kinds: [
			...new Set(
				cases.flatMap((generated) => Object.keys(generated.expected ?? {})),
			),
		].sort(),
	});
};
