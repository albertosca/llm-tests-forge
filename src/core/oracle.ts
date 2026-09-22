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
			if (expected.fields === undefined)
				return "oracle is fields but expected.fields is missing";
			// The assert compares the keys this object names and nothing
			// else, so an empty object checks nothing and passes against any
			// output. A model told to omit judgement calls omitted them all
			// (measured on the second real target, 2026-09-22).
			if (Object.keys(expected.fields).length === 0)
				return "oracle is fields but expected.fields is empty, so nothing would be checked";
			return null;
		case "rubric":
			return expected.rubric === undefined
				? "oracle is rubric but expected.rubric is missing"
				: null;
	}
}
