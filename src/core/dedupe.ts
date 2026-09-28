import { stringify } from "yaml";
import { z } from "zod";
import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import type { Case } from "./schemas";

export const DedupeOutputSchema = z.object({
	duplicates: z.array(z.object({ id: z.string(), duplicate_of: z.string() })),
});

export interface DedupeArgs {
	cases: Case[];
	model: string;
	llm: Llm;
}

export async function dedupeCases(request: DedupeArgs): Promise<Case[]> {
	if (request.cases.length < 2) return request.cases;
	const template = loadTemplate("dedupe");
	const prompt = render(template, {
		cases: stringify(
			request.cases.map((testCase) => ({
				id: testCase.id,
				input: testCase.input,
				expected: testCase.expected,
			})),
			{ lineWidth: 0 },
		),
	});
	const { object } = await request.llm.generate({
		schema: DedupeOutputSchema,
		prompt,
		model: request.model,
		verb: "dedupe",
	});
	const byId = new Map(
		request.cases.map((testCase) => [testCase.id, testCase]),
	);
	const marks = new Map<string, string>();
	for (const pair of object.duplicates) {
		const target = byId.get(pair.id);
		if (
			!target ||
			!byId.has(pair.duplicate_of) ||
			pair.id === pair.duplicate_of
		)
			continue;
		if (target.status === "approved" || target.status === "edited") continue;
		marks.set(pair.id, pair.duplicate_of);
	}
	return request.cases.map((testCase) =>
		marks.has(testCase.id)
			? { ...testCase, duplicate_of: marks.get(testCase.id) }
			: testCase,
	);
}
