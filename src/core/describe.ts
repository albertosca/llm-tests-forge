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

export async function describeFeature(request: DescribeArgs): Promise<Feature> {
	if (request.text.trim() === "")
		throw new ForgeError("describe needs a non-empty description");
	const template = loadTemplate("describe");
	const prompt = render(template, {
		description: request.text.trim(),
		prompt: request.promptText ?? "",
	});
	const { object } = await request.llm.generate({
		schema: DescribeOutputSchema,
		prompt,
		model: request.model,
		verb: "describe",
	});
	return { ...object, status: "pending" };
}
