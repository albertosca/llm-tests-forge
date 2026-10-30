import { parse } from "yaml";
import { z } from "zod";
import { dedupeCases } from "../../src/core/dedupe";
import { ForgeError } from "../../src/core/errors";
import { type Case, CaseSchema } from "../../src/core/schemas";
import type { Handler } from "./entry";

const CaseDraftSchema = CaseSchema.pick({
	id: true,
	input: true,
	expected: true,
});

/** The suite's `cases` input: a YAML list of {id, input, expected}, every one made `pending` so none is skipped as already reviewed. */
export function casesFromText(text: string): Case[] {
	const parsed = z.array(CaseDraftSchema).safeParse(parse(text));
	if (!parsed.success)
		throw new ForgeError(
			`the cases input is not a list of cases with id and input: ${parsed.error.message}`,
		);
	return parsed.data.map((draft) => ({
		...draft,
		scenario: "dogfood",
		status: "pending",
		generated_by: "dogfood",
	}));
}

/** Runs the real `dedupeCases` and prints the pairs it marked, sorted by id. */
export const runDedupe: Handler = async (invocation, llm) => {
	const text = invocation.variables.cases;
	if (text === undefined)
		throw new ForgeError("the dedupe target needs the `cases` input");
	const marked = await dedupeCases({
		cases: casesFromText(text),
		model: invocation.model,
		llm,
	});
	const duplicates = marked
		.flatMap((testCase) =>
			testCase.duplicate_of === undefined
				? []
				: [{ id: testCase.id, duplicate_of: testCase.duplicate_of }],
		)
		.sort((left, right) => left.id.localeCompare(right.id));
	return JSON.stringify({ duplicates });
};
