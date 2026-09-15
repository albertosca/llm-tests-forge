import { z } from "zod";

export const Kind = z.enum([
	"happy",
	"edge",
	"ambiguous",
	"out_of_scope",
	"adversarial",
	"language",
]);
export const Oracle = z.enum(["label", "fields", "rubric"]);
export const Status = z.enum(["pending", "approved", "rejected", "edited"]);
export const FeatureStatus = z.enum(["pending", "approved", "edited"]);

export const FeatureInputSchema = z.object({
	name: z.string().min(1),
	kind: z.enum(["text", "json"]),
	notes: z.string().optional(),
});

export const FeatureOutputSchema = z
	.object({
		kind: z.enum(["text", "json", "label"]),
		fields: z.array(z.string()).optional(),
		label_field: z.string().optional(),
		labels: z.array(z.string()).optional(),
	})
	.refine(
		(o) =>
			o.kind !== "label" || (o.labels !== undefined && o.labels.length > 0),
		{
			message: "output.kind 'label' requires a non-empty labels list",
		},
	);

export const FeatureSchema = z.object({
	id: z.string().min(1),
	purpose: z.string().min(1),
	inputs: z.array(FeatureInputSchema).min(1),
	output: FeatureOutputSchema,
	invariants: z.array(z.string()).default([]),
	prompt_file: z.string().optional(),
	status: FeatureStatus,
});

export const ScenarioSchema = z.object({
	id: z.string().min(1),
	kind: Kind,
	oracle: Oracle,
	description: z.string().min(1),
	status: Status,
});

export const ExpectedSchema = z
	.object({
		label: z.string().optional(),
		fields: z.record(z.string(), z.unknown()).optional(),
		rubric: z.string().optional(),
	})
	.refine(
		(e) =>
			[e.label, e.fields, e.rubric].filter((v) => v !== undefined).length === 1,
		{
			message: "expected must carry exactly one of label, fields, rubric",
		},
	);

export const CaseSchema = z.object({
	id: z.string().min(1),
	scenario: z.string().min(1),
	input: z.record(z.string(), z.string()),
	expected: ExpectedSchema.optional(),
	status: Status,
	generated_by: z.string().min(1),
	duplicate_of: z.string().optional(),
});

export const SuiteSchema = z.object({
	target: z.object({
		kind: z.literal("promptfoo-python"),
		entry: z.string().min(1),
		models: z.array(z.string()).min(1),
	}),
	judges: z.array(z.string()).min(1),
	repeat: z.number().int().min(1).default(1),
	include: z.array(z.string()).default([]),
});

export type Kind = z.infer<typeof Kind>;
export type Oracle = z.infer<typeof Oracle>;
export type Status = z.infer<typeof Status>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;
export type Case = z.infer<typeof CaseSchema>;
export type Suite = z.infer<typeof SuiteSchema>;
