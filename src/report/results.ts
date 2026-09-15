import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ForgeError } from "../core/errors";

/**
 * promptfoo's `results.json` as far as the forge needs it, and no further.
 *
 * Every field an error row may omit is optional or nullish on purpose: a
 * run that half-failed is exactly the run whose report matters most, so a
 * schema that rejects it would refuse to explain the failure it was written
 * to explain. Unknown keys are ignored rather than rejected — promptfoo
 * writes far more per row than this reads, and a new key in a later version
 * must not break a report.
 */
export const PromptfooResultsSchema = z.object({
	results: z.object({
		results: z.array(
			z.object({
				testIdx: z.number(),
				success: z.boolean(),
				error: z.string().nullish(),
				cost: z.number().nullish(),
				latencyMs: z.number().nullish(),
				tokenUsage: z
					.object({
						prompt: z.number().optional(),
						completion: z.number().optional(),
						total: z.number().optional(),
					})
					.partial()
					.nullish(),
				provider: z.object({ id: z.string(), label: z.string().nullish() }),
				metadata: z.record(z.string(), z.unknown()).nullish(),
				gradingResult: z
					.object({
						pass: z.boolean().optional(),
						componentResults: z
							.array(
								z.object({
									pass: z.boolean(),
									reason: z.string().optional(),
									assertion: z
										.object({
											type: z.string(),
											provider: z.string().optional(),
											value: z.unknown().optional(),
										})
										.optional(),
									tokensUsed: z
										.object({
											prompt: z.number().optional(),
											completion: z.number().optional(),
											total: z.number().optional(),
											completionDetails: z
												.object({ reasoning: z.number().optional() })
												.partial()
												.optional(),
										})
										.partial()
										.optional(),
								}),
							)
							.optional(),
					})
					.partial()
					.nullish(),
			}),
		),
	}),
	metadata: z
		.object({ promptfooVersion: z.string().optional() })
		.partial()
		.optional(),
});

export type PromptfooResults = z.infer<typeof PromptfooResultsSchema>;
export type PromptfooRow = PromptfooResults["results"]["results"][number];

/**
 * JSON, not YAML, so this cannot reuse `readYamlFile`; it keeps the same
 * three failure shapes that file uses — unreadable, unparseable, wrong
 * shape — each naming the file the person passed.
 */
export async function readResults(path: string): Promise<PromptfooResults> {
	const text = await readFile(path, "utf8").catch((e: unknown) => {
		const code = (e as { code?: string }).code;
		throw new ForgeError(
			code === "ENOENT"
				? "file not found"
				: `cannot read: ${(e as Error).message}`,
			{ file: path },
		);
	});
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new ForgeError(`invalid JSON: ${(e as Error).message}`, {
			file: path,
		});
	}
	const parsed = PromptfooResultsSchema.safeParse(data);
	if (!parsed.success)
		throw new ForgeError(
			`does not match promptfoo's results shape: ${parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
			{ file: path },
		);
	return parsed.data;
}
