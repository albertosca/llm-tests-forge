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

export async function dedupeCases(args: DedupeArgs): Promise<Case[]> {
	if (args.cases.length < 2) return args.cases;
	const template = await loadTemplate("dedupe");
	const prompt = render(template, {
		cases: stringify(
			args.cases.map((c) => ({
				id: c.id,
				input: c.input,
				expected: c.expected,
			})),
			{ lineWidth: 0 },
		),
	});
	const { object } = await args.llm.generate({
		schema: DedupeOutputSchema,
		prompt,
		model: args.model,
		verb: "dedupe",
	});
	const byId = new Map(args.cases.map((c) => [c.id, c]));
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
	return args.cases.map((c) =>
		marks.has(c.id) ? { ...c, duplicate_of: marks.get(c.id) } : c,
	);
}
