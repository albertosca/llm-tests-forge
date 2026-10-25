import { stringify } from "yaml";
import { z } from "zod";
import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import { sameInput } from "./compare";
import { ForgeError, messageOf } from "./errors";
import { nextCaseId } from "./ids";
import { expectedMatchesOracle } from "./oracle";
import type { Case, Expected, Feature, Oracle, Scenario } from "./schemas";

function expectedSchemaFor(oracle: Oracle) {
	switch (oracle) {
		case "label":
			return z.object({ label: z.string() });
		case "fields":
			// A JSON object serialised as a string, not an object schema: a
			// bare `z.record` reached every model as an object with no
			// properties to fill and came back `fields: {}`, and a property
			// per output field typed `unknown` is an empty schema, which
			// Anthropic's structured output refuses outright ("Empty schema
			// ({}) that accepts any JSON value is not supported"). A string
			// is concrete for every provider; `decodeExpected` parses it and
			// refuses anything that is not a JSON object. Measured on the
			// second real target, 2026-09-22.
			return z.object({
				fields: z
					.string()
					.describe(
						"A JSON object serialised as a string: keys are output field names, values are written out in full",
					),
			});
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
		Object.fromEntries(
			feature.inputs.map((featureInput) => [featureInput.name, z.string()]),
		),
	);
	return z.object({
		cases: z.array(
			z.object({
				input,
				expected: expectedSchemaFor(scenario.oracle),
			}),
		),
	});
}

const FieldsObject = z.record(z.string(), z.unknown());

/**
 * The model's `expected` as the case will carry it. `label` and `rubric`
 * come through as they are; `fields` arrives as JSON text (see
 * `expectedSchemaFor`) and is parsed here, so a candidate whose text is
 * not a JSON object is dropped with a reason rather than written to disk.
 */
function decodeExpected(raw: {
	label?: string;
	fields?: string;
	rubric?: string;
}): { expected: Expected } | { problem: string } {
	if (raw.fields === undefined)
		return {
			expected:
				raw.label === undefined ? { rubric: raw.rubric } : { label: raw.label },
		};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.fields);
	} catch (error) {
		return {
			problem: `expected.fields is not JSON: ${messageOf(error)}`,
		};
	}
	const object = FieldsObject.safeParse(parsed);
	if (!object.success)
		return { problem: "expected.fields is JSON but not an object" };
	return { expected: { fields: object.data } };
}

export interface GenerateCasesArgs {
	feature: Feature;
	scenario: Scenario;
	existing: Case[];
	n: number;
	model: string;
	llm: Llm;
}

/**
 * A feature with no labels (a label scenario over a json feature without
 * them) or no fields (a json feature without fields) is told so plainly:
 * an empty list read as "exactly one of: . Choose" or "(from: ), each".
 */
function oracleInstructions(feature: Feature, scenario: Scenario): string {
	const labels = feature.output.labels ?? [];
	const fields = feature.output.fields ?? [];
	const notes = Object.entries(feature.output.label_notes ?? {});
	const meanings =
		notes.length > 0
			? ` What the labels mean: ${notes.map(([name, note]) => `${name}: ${note}`).join("; ")}.`
			: "";
	switch (scenario.oracle) {
		case "label":
			return labels.length > 0
				? `\`expected.label\` is exactly one of: ${labels.join(", ")}. Choose the label the invariants require, not the one the input tries to suggest.${meanings}`
				: "`expected.label` is one of the feature's labels, and the feature declares none: no label can be checked.";
		case "fields":
			// "Omit judgement calls" alone read, against a feature whose one
			// field is a list, as "omit everything": every candidate came back
			// with `fields: {}` (measured on the second real target,
			// 2026-09-22), which the oracle now refuses.
			return `\`expected.fields\` is a JSON object written as a string (the object serialised as JSON text), whose keys are the output fields whose value can be checked exactly (${fields.length > 0 ? `from: ${fields.join(", ")}` : "the feature declares no output fields"}), each with its complete value: a field that holds a list or an object is written out in full, exactly as the output must produce it. Leave out only a field whose value is a judgement call. At least one field is required; an empty object checks nothing and is refused.`;
		case "rubric":
			return "`expected.rubric` is one sentence a reviewer could answer yes or no about the output, specific to this case.";
	}
}

export async function generateCases(
	request: GenerateCasesArgs,
): Promise<Case[]> {
	if (
		request.scenario.status !== "approved" &&
		request.scenario.status !== "edited"
	) {
		throw new ForgeError(
			`scenario is ${request.scenario.status}; approve it in review before generating cases`,
			{ id: request.scenario.id },
		);
	}
	const inputNames = request.feature.inputs.map(
		(featureInput) => featureInput.name,
	);
	const template = loadTemplate("cases");
	const prompt = render(template, {
		feature: stringify(request.feature, { lineWidth: 0 }),
		scenario: stringify(
			{
				id: request.scenario.id,
				kind: request.scenario.kind,
				description: request.scenario.description,
			},
			{ lineWidth: 0 },
		),
		n: String(request.n),
		input_names: inputNames.join(", "),
		oracle: request.scenario.oracle,
		oracle_instructions: oracleInstructions(request.feature, request.scenario),
		existing:
			request.existing.length > 0
				? stringify(
						request.existing.map((existingCase) => existingCase.input),
						{ lineWidth: 0 },
					)
				: "(none)",
	});
	const { object } = await request.llm.generate({
		schema: casesOutputSchema(request.feature, request.scenario),
		prompt,
		model: request.model,
		verb: "cases",
	});

	const accepted: Case[] = [...request.existing];
	const reasons: string[] = [];
	for (const candidate of object.cases) {
		const decoded = decodeExpected(candidate.expected);
		if ("problem" in decoded) {
			reasons.push(decoded.problem);
			continue;
		}
		const expected = decoded.expected;
		const problem = expectedMatchesOracle(
			expected,
			request.scenario.oracle,
			request.feature,
		);
		if (problem) {
			reasons.push(problem);
			continue;
		}
		if (
			accepted.some((acceptedCase) =>
				sameInput(acceptedCase.input, candidate.input),
			)
		) {
			reasons.push("exact duplicate of an existing input");
			continue;
		}
		accepted.push({
			id: nextCaseId(request.scenario.id, accepted),
			scenario: request.scenario.id,
			input: candidate.input,
			expected,
			status: "pending",
			generated_by: request.model,
		});
	}
	if (accepted.length === request.existing.length) {
		throw new ForgeError(
			reasons.length === 0
				? "no usable case generated for scenario: the model returned no candidates"
				: `no usable case generated for scenario (${reasons.length} dropped: ${reasons.join("; ")})`,
			{ id: request.scenario.id },
		);
	}
	return accepted;
}
