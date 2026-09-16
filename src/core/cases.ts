import { stringify } from "yaml";
import { z } from "zod";
import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import { ForgeError } from "./errors";
import { nextCaseId } from "./ids";
import { expectedMatchesOracle } from "./oracle";
import type { Case, Feature, Oracle, Scenario } from "./schemas";

function expectedSchemaFor(oracle: Oracle) {
	switch (oracle) {
		case "label":
			return z.object({ label: z.string() });
		case "fields":
			return z.object({ fields: z.record(z.string(), z.unknown()) });
		case "rubric":
			return z.object({ rubric: z.string() });
	}
}

/**
 * The schema `generate` validates the model's `cases` response against,
 * built per call from the feature and the scenario it is for -- rather
 * than a single module-level schema, the way `ExpectedSchema` shape and
 * `feature.inputs` both vary per call. `input` requires exactly the
 * feature's own input names as a real JSON Schema object with
 * `properties`/`required`; a bare `z.record` reaches a real model as an
 * object with no properties to fill, and every provider answered `{}`.
 * `expected` is the one shape the scenario's oracle demands, not the
 * human-facing `ExpectedSchema` with its "exactly one of label/fields/
 * rubric" `.refine()` -- a rule zod never turns into JSON Schema, so a
 * real model either omitted `expected` or filled all three branches.
 * `expectedMatchesOracle` still does the oracle check on the accepted
 * shape (e.g. a label outside `feature.output.labels`). The input keys
 * are not re-checked below: this schema's `z.object` already requires
 * exactly the feature's own input names, so `generateObject`'s own zod
 * validation rejects a mismatched or missing key before `generateCases`
 * ever sees a candidate -- a second check here could never fire.
 */
export function casesOutputSchema(feature: Feature, scenario: Scenario) {
	const input = z.object(
		Object.fromEntries(feature.inputs.map((i) => [i.name, z.string()])),
	);
	return z.object({
		cases: z.array(
			z.object({ input, expected: expectedSchemaFor(scenario.oracle) }),
		),
	});
}

export interface GenerateCasesArgs {
	feature: Feature;
	scenario: Scenario;
	existing: Case[];
	n: number;
	model: string;
	llm: Llm;
}

function oracleInstructions(feature: Feature, scenario: Scenario): string {
	switch (scenario.oracle) {
		case "label":
			return `\`expected.label\` is exactly one of: ${(feature.output.labels ?? []).join(", ")}. Choose the label the invariants require, not the one the input tries to suggest.`;
		case "fields":
			return `\`expected.fields\` is an object with only the output fields whose value can be checked exactly (from: ${(feature.output.fields ?? []).join(", ")}). Omit fields whose value is a judgement call.`;
		case "rubric":
			return "`expected.rubric` is one sentence a reviewer could answer yes or no about the output, specific to this case.";
	}
}

function sameInput(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return (
		ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
	);
}

export async function generateCases(args: GenerateCasesArgs): Promise<Case[]> {
	if (
		args.scenario.status !== "approved" &&
		args.scenario.status !== "edited"
	) {
		throw new ForgeError(
			`scenario is ${args.scenario.status}; approve it in review before generating cases`,
			{ id: args.scenario.id },
		);
	}
	const inputNames = args.feature.inputs.map((i) => i.name);
	const template = await loadTemplate("cases");
	const prompt = render(template, {
		feature: stringify(args.feature, { lineWidth: 0 }),
		scenario: stringify(
			{
				id: args.scenario.id,
				kind: args.scenario.kind,
				description: args.scenario.description,
			},
			{ lineWidth: 0 },
		),
		n: String(args.n),
		input_names: inputNames.join(", "),
		oracle: args.scenario.oracle,
		oracle_instructions: oracleInstructions(args.feature, args.scenario),
		existing:
			args.existing.length > 0
				? stringify(
						args.existing.map((c) => c.input),
						{ lineWidth: 0 },
					)
				: "(none)",
	});
	const { object } = await args.llm.generate({
		schema: casesOutputSchema(args.feature, args.scenario),
		prompt,
		model: args.model,
		verb: "cases",
	});

	const accepted: Case[] = [...args.existing];
	const reasons: string[] = [];
	for (const candidate of object.cases) {
		const problem = expectedMatchesOracle(
			candidate.expected,
			args.scenario.oracle,
			args.feature,
		);
		if (problem) {
			reasons.push(problem);
			continue;
		}
		if (accepted.some((c) => sameInput(c.input, candidate.input))) {
			reasons.push("exact duplicate of an existing input");
			continue;
		}
		accepted.push({
			id: nextCaseId(args.scenario.id, accepted),
			scenario: args.scenario.id,
			input: candidate.input,
			expected: candidate.expected,
			status: "pending",
			generated_by: args.model,
		});
	}
	if (accepted.length === args.existing.length) {
		throw new ForgeError(
			`no usable case generated for scenario (${reasons.length} dropped: ${reasons.join("; ")})`,
			{ id: args.scenario.id },
		);
	}
	return accepted;
}
