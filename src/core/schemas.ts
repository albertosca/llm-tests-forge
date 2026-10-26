import { z } from "zod";
import { EMPTY_RESPONSE_REFUSAL, RESPONSE_FUNCTION_REFUSAL } from "./target";

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

/**
 * Every input becomes a `{{<name>}}` in the emitted prompt and the http
 * default body, and promptfoo 0.123.0 renders those with Nunjucks, which has
 * no lookup by an arbitrary key (`_vars["a b"]`, `vars[...]`, `context[...]`
 * and `this[...]` all render empty, measured with a one-case eval). So a
 * name must be a Nunjucks identifier: `user message` and `not` fail the
 * render, `user-message` renders NaN, and `true`, `false`, `none`, `null`
 * render as literals instead of the input. Measured in the same run:
 * `and`, `or`, `in`, `is`, `if`, `NOT` and `True` render the input.
 *
 * A leading underscore is refused too: promptfoo puts its own variables in
 * the same vars (`__evalId`, `__repeatIndex`, `_conversation`), so an input
 * of that name hands the target promptfoo's value (measured: the eval id,
 * `0`, empty), and `__proto__` is dropped when a case file is read.
 */
const TEMPLATE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const TEMPLATE_LITERALS = ["not", "true", "false", "none", "null"];

export const FeatureInputSchema = z.object({
	name: z
		.string()
		.min(1, { abort: true })
		.refine(
			(name) => TEMPLATE_NAME.test(name) && !TEMPLATE_LITERALS.includes(name),
			{
				error: (issue) =>
					`input name "${String(issue.input)}" cannot be referenced in promptfoo's templates; use ASCII letters, digits and underscores, starting with a letter (a leading underscore is promptfoo's own), and none of ${TEMPLATE_LITERALS.join(", ")}; rename it everywhere: in feature.yaml, in every case's input: keys, and in the target or shim code`,
			},
		),
	kind: z.enum(["text", "json"]),
	notes: z.string().optional(),
});

export const FeatureOutputSchema = z
	.object({
		kind: z.enum(["text", "json", "label"]),
		fields: z.array(z.string()).optional(),
		label_field: z.string().optional(),
		labels: z.array(z.string()).optional(),
		label_notes: z.record(z.string(), z.string()).optional(),
	})
	.refine(
		(output) =>
			output.kind !== "label" ||
			(output.labels !== undefined && output.labels.length > 0),
		{
			message: "output.kind 'label' requires a non-empty labels list",
		},
	)
	.refine(
		(output) =>
			Object.keys(output.label_notes ?? {}).every((name) =>
				output.labels?.includes(name),
			),
		{
			error: (issue) => {
				const output = issue.input as {
					labels?: string[];
					label_notes: Record<string, string>;
				};
				const unknown = Object.keys(output.label_notes).filter(
					(name) => !output.labels?.includes(name),
				);
				return `output.label_notes describes ${unknown.map((name) => `"${name}"`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in output.labels`;
			},
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
		(expected) =>
			[expected.label, expected.fields, expected.rubric].filter(
				(value) => value !== undefined,
			).length === 1,
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

export const TARGET_KINDS = [
	"python",
	"javascript",
	"typescript",
	"elixir",
	"ruby",
	"rust",
	"go",
	"exec",
	"http",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const LANGUAGES = [
	"python",
	"javascript",
	"typescript",
	"elixir",
	"ruby",
	"rust",
	"go",
	"other",
] as const;
export type Language = (typeof LANGUAGES)[number];

export const ProjectConfigSchema = z.object({
	version: z.literal(1),
	language: z.enum(LANGUAGES),
	suites: z.preprocess((value) => value ?? [], z.array(z.string().min(1))),
	// A `defaults:` with every key commented out is null, read as {} like `suites`.
	defaults: z.preprocess(
		(value) => value ?? {},
		z.object({
			drafter: z.string().min(1).optional(),
			target_models: z.array(z.string().min(1)).min(1).optional(),
			judges: z.array(z.string().min(1)).min(1).optional(),
		}),
	),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

const TargetSchema = z
	.object({
		// Suites written before the kinds existed say promptfoo-python.
		kind: z.preprocess(
			(value) => (value === "promptfoo-python" ? "python" : value),
			z.enum(TARGET_KINDS),
		),
		/** The shim's file (or, for rust and go, directory) inside .forge; absent → the kind's default. */
		entry: z.string().min(1).optional(),
		models: z.array(z.string()).min(1),
		/** Interpreter for the python shim; promptfoo's `pythonExecutable`. */
		python: z.string().min(1).optional(),
		/** The command promptfoo runs for kind exec, from .forge/. */
		command: z.string().min(1).optional(),
		url: z.string().min(1).optional(),
		method: z.string().min(1).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		/** The request body for kind http; each feature input is available as `{{<input name>}}`. Absent → one key per feature input. */
		body: z.unknown().optional(),
		/** An expression over `json` naming the part of the http response that is the output. */
		response: z.string().optional(),
	})
	// Each issue's `code` is left as zod's "custom". Zod keeps whatever code it
	// is given (probed with zod 4.6.5), and the forge reports an issue by its
	// path and message alone (describeIssue in files.ts, and review.ts), never
	// by its code, so an empty code reads the same to a person. Hence the
	// StringLiteral disables below; the schemas test "a target refusal reads
	// as its path and message alone" guards it.
	.superRefine((target, context) => {
		if (target.kind === "exec" && target.command === undefined)
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["command"],
				message: "target.command is required when target.kind is exec",
			});
		if (target.kind === "http" && target.url === undefined)
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["url"],
				message: "target.url is required when target.kind is http",
			});
		if (target.url !== undefined && !/^https?:\/\//i.test(target.url))
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["url"],
				message: "target.url must start with http:// or https://",
			});
		if (target.body === null)
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["body"],
				message:
					"target.body is null; remove the key to send one field per input",
			});
		if (target.response !== undefined && target.response.trim() === "")
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["response"],
				message: EMPTY_RESPONSE_REFUSAL,
			});
		if (target.response?.includes("=>"))
			context.addIssue({
				// Stryker disable next-line StringLiteral: the code is never read, see above.
				code: "custom",
				path: ["response"],
				message: RESPONSE_FUNCTION_REFUSAL,
			});
	});

/** What `stamp` seals and `check` verifies: the files whose change invalidates a blessed run, and the line a run must clear. */
export const StampBlockSchema = z.object({
	/** Paths or globs relative to the directory that holds `.forge/`. */
	inputs: z.array(z.string().min(1)).min(1),
	minimum_pass_rate: z.number().min(0).max(1),
});

export const SuiteSchema = z.object({
	/** The forge version that last wrote this suite; absent on suites older than the stamp. */
	forge_version: z.string().optional(),
	target: TargetSchema,
	judges: z.array(z.string()).min(1),
	repeat: z.number().int().min(1).default(1),
	include: z.array(z.string()).default([]),
	stamp: StampBlockSchema.optional(),
});

export const PricesSchema = z.object({
	updated: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "updated must be YYYY-MM-DD"),
	unit: z.literal("usd_per_million_tokens"),
	sources: z.array(z.string()).default([]),
	models: z
		.record(
			z.string(),
			z.object({
				input: z.number().nonnegative(),
				output: z.number().nonnegative(),
			}),
		)
		.refine((models) => Object.keys(models).length > 0, {
			message: "models must list at least one model",
		}),
});

export type Kind = z.infer<typeof Kind>;
export type Oracle = z.infer<typeof Oracle>;
export type Status = z.infer<typeof Status>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;
export type Case = z.infer<typeof CaseSchema>;
export type Suite = z.infer<typeof SuiteSchema>;
export type StampBlock = z.infer<typeof StampBlockSchema>;
export type Prices = z.infer<typeof PricesSchema>;
