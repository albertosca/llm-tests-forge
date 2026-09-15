import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import { ForgeError } from "./errors";
import { type Feature, FeatureSchema } from "./schemas";

export const DescribeOutputSchema = FeatureSchema.omit({
	status: true,
	prompt_file: true,
});

export interface DescribeArgs {
	text: string;
	promptText?: string;
	model: string;
	llm: Llm;
}

export async function describeFeature(args: DescribeArgs): Promise<Feature> {
	if (args.text.trim() === "")
		throw new ForgeError("describe needs a non-empty description");
	const template = await loadTemplate("describe");
	const prompt = render(template, {
		description: args.text.trim(),
		prompt: args.promptText ?? "",
	});
	const { object } = await args.llm.generate({
		schema: DescribeOutputSchema,
		prompt,
		model: args.model,
		verb: "describe",
	});
	return { ...object, status: "pending" };
}
