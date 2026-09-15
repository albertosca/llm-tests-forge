import type { Expected, Feature, Oracle } from "./schemas";

/**
 * The one rule for whether an `expected` value satisfies the oracle its
 * scenario declares. It lives here, rather than beside the case generator
 * that first needed it, because both producers of an expected value answer
 * to it: the model, in `generateCases`, and the person, at the review
 * prompt. A second copy of this rule written for the human side is how the
 * two drift apart.
 *
 * Returns `null` when the value is acceptable, or a sentence naming what is
 * wrong with it.
 */
export function expectedMatchesOracle(
	expected: Expected,
	oracle: Oracle,
	feature: Feature,
): string | null {
	switch (oracle) {
		case "label":
			if (expected.label === undefined)
				return "oracle is label but expected.label is missing";
			if (!(feature.output.labels ?? []).includes(expected.label))
				return `label "${expected.label}" is not one of the feature's labels`;
			return null;
		case "fields":
			return expected.fields === undefined
				? "oracle is fields but expected.fields is missing"
				: null;
		case "rubric":
			return expected.rubric === undefined
				? "oracle is rubric but expected.rubric is missing"
				: null;
	}
}
