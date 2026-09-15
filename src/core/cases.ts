import { stringify } from "yaml";
import { z } from "zod";
import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import { ForgeError } from "./errors";
import { nextCaseId } from "./ids";
import {
	type Case,
	type Expected,
	ExpectedSchema,
	type Feature,
	type Scenario,
} from "./schemas";

export const CasesOutputSchema = z.object({
	cases: z.array(
		z.object({
			input: z.record(z.string(), z.string()),
			expected: ExpectedSchema,
		}),
	),
});

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

export function expectedMatchesOracle(
	expected: Expected,
	scenario: Scenario,
	feature: Feature,
): string | null {
	switch (scenario.oracle) {
		case "label":
			if (expected.label === undefined)
				return "oracle is label but expected.label is missing";
			if (!(feature.output.labels ?? []).includes(expected.label))
				return `label "${expected.label}" is not one of the feature's labels`;
			return null;
		case "fields":
			return expected.fields === undefined
				? "oracle is fields but expected.fields is missing"
				: null;
		case "rubric":
			return expected.rubric === undefined
				? "oracle is rubric but expected.rubric is missing"
				: null;
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
		schema: CasesOutputSchema,
		prompt,
		model: args.model,
		verb: "cases",
	});

	const accepted: Case[] = [...args.existing];
	const reasons: string[] = [];
	for (const candidate of object.cases) {
		const keys = Object.keys(candidate.input).sort();
		if (
			keys.length !== inputNames.length ||
			!keys.every((k) => inputNames.includes(k))
		) {
			reasons.push(
				`input keys [${keys.join(", ")}] do not match feature inputs [${inputNames.join(", ")}]`,
			);
			continue;
		}
		const problem = expectedMatchesOracle(
			candidate.expected,
			args.scenario,
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
