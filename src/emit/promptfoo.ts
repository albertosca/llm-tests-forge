import { stringify } from "yaml";
import { ForgeError } from "../core/errors";
import type {
	Expected,
	Feature,
	Kind,
	Oracle,
	Scenario,
	Suite,
} from "../core/schemas";
import type { Selection } from "../core/select";
import { toPromptfooProvider } from "./providers";

export interface PromptfooAssert {
	type: "javascript" | "llm-rubric";
	value: string;
	provider?: string;
}
export interface PromptfooTest {
	description: string;
	metadata: { scenario: string; case: string; kind: Kind; oracle: Oracle };
	vars: Record<string, string>;
	assert: PromptfooAssert[];
}
export interface PromptfooProvider {
	id: string;
	label: string;
	config: { model: string; pythonExecutable?: string };
}
export interface PromptfooConfig {
	description: string;
	prompts: string[];
	providers: PromptfooProvider[];
	evaluateOptions: { repeat: number };
	tests: PromptfooTest[];
}

/**
 * Runs inside promptfoo's javascript assert. Strips a code fence and takes
 * the first {...} so the suite measures what the application returned, not
 * how it was formatted — the spike's eight false failures were exactly that.
 * Leaves `obj` in scope for the snippet appended after it.
 */
export const TOLERANT_PARSE = [
	'const text = String(output).replace(/^\\s*```(?:json)?\\s*/i, "").replace(/\\s*```\\s*$/, "");',
	'const start = text.indexOf("{"); const end = text.lastIndexOf("}");',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: this is generated JS source, not a template string of our own.
	"if (start < 0 || end < start) return `no JSON object in output: ${text.slice(0, 80)}`;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"let obj; try { obj = JSON.parse(text.slice(start, end + 1)); } catch (e) { return `output is not JSON: ${e.message}`; }",
].join("\n");

function labelAssert(
	feature: Feature,
	label: string,
	featureFile: string,
): PromptfooAssert {
	const want = JSON.stringify(label);
	if (feature.output.kind === "label") {
		return {
			type: "javascript",
			value: `const got = String(output).trim();\nreturn got === ${want} ? true : "output was " + JSON.stringify(got) + ", expected " + ${want};`,
		};
	}
	if (feature.output.kind === "json") {
		const field = feature.output.label_field;
		if (!field)
			throw new ForgeError(
				"a label oracle on a json feature needs output.label_field",
				{ file: featureFile, id: feature.id },
			);
		const f = JSON.stringify(field);
		return {
			type: "javascript",
			value: `${TOLERANT_PARSE}\nreturn obj[${f}] === ${want} ? true : ${f} + " was " + JSON.stringify(obj[${f}]) + ", expected " + ${want};`,
		};
	}
	throw new ForgeError(
		"a label oracle cannot be checked against a text output",
		{ file: featureFile, id: feature.id },
	);
}

function fieldsAssert(fields: Record<string, unknown>): PromptfooAssert {
	const want = JSON.stringify(fields);
	return {
		type: "javascript",
		value: `${TOLERANT_PARSE}\nconst want = ${want};\nconst bad = Object.keys(want).filter((k) => JSON.stringify(obj[k]) !== JSON.stringify(want[k]));\nreturn bad.length === 0 ? true : \`fields differ: \${bad.map((k) => \`\${k}=\${JSON.stringify(obj[k])} (expected \${JSON.stringify(want[k])})\`).join(", ")}\`;`,
	};
}

/**
 * The oracle decides which half of `expected` is read, so each arm narrows
 * to it rather than defaulting: a missing value used to become `""` or
 * `{}`, which emits an assert that passes against anything. `selectCases`
 * refuses such a pair before emit is reached; these throws are what a
 * library caller who built a `Selection` by hand gets instead.
 */
function assertsFor(
	caseId: string,
	expected: Expected,
	scenario: Scenario,
	feature: Feature,
	suite: Suite,
	featureFile: string,
): PromptfooAssert[] {
	switch (scenario.oracle) {
		case "label":
			if (expected.label === undefined)
				throw new ForgeError(
					`case ${caseId}: oracle is label but expected.label is missing`,
					{ id: caseId },
				);
			return [labelAssert(feature, expected.label, featureFile)];
		case "fields":
			if (expected.fields === undefined)
				throw new ForgeError(
					`case ${caseId}: oracle is fields but expected.fields is missing`,
					{ id: caseId },
				);
			return [fieldsAssert(expected.fields)];
		case "rubric": {
			const rubric = expected.rubric;
			if (rubric === undefined)
				throw new ForgeError(
					`case ${caseId}: oracle is rubric but expected.rubric is missing`,
					{ id: caseId },
				);
			return suite.judges.map((j) => ({
				type: "llm-rubric" as const,
				value: rubric,
				provider: toPromptfooProvider(j),
			}));
		}
	}
}

export function buildPromptfooConfig(args: {
	feature: Feature;
	suite: Suite;
	selection: Selection;
	featureFile?: string;
}): PromptfooConfig {
	const { feature, suite, selection } = args;
	const featureFile = args.featureFile ?? "feature.yaml";
	if (selection.cases.length === 0)
		throw new ForgeError("no approved case to emit; run `forge review` first", {
			file: featureFile,
		});
	const byId = new Map(selection.scenarios.map((s) => [s.id, s]));
	const tests: PromptfooTest[] = selection.cases.map((c) => {
		const scenario = byId.get(c.scenario);
		// selectCases only returns cases of selected scenarios with an expected; both guards are for a hand-built Selection.
		if (!scenario)
			throw new ForgeError(
				`case ${c.id} names scenario "${c.scenario}", which is not selected`,
				{ id: c.id },
			);
		if (!c.expected)
			throw new ForgeError(`case ${c.id} has no expected`, { id: c.id });
		return {
			description: c.id,
			metadata: {
				scenario: scenario.id,
				case: c.id,
				kind: scenario.kind,
				oracle: scenario.oracle,
			},
			vars: c.input,
			assert: assertsFor(
				c.id,
				c.expected,
				scenario,
				feature,
				suite,
				featureFile,
			),
		};
	});
	const firstInput = feature.inputs[0]?.name ?? "input";
	return {
		description: `${feature.id}: forge suite, ${selection.cases.length} cases from ${selection.scenarios.length} scenarios`,
		prompts: [`{{${firstInput}}}`],
		providers: suite.target.models.map((model) => ({
			id: `file://${suite.target.entry}`,
			label: model,
			config: suite.target.python
				? { model, pythonExecutable: suite.target.python }
				: { model },
		})),
		evaluateOptions: { repeat: suite.repeat },
		tests,
	};
}

export function renderPromptfooConfig(config: PromptfooConfig): string {
	return `# Written by forge emit; edit suite.yaml and re-run instead of editing this file.\n${stringify(config, { lineWidth: 0 })}`;
}
