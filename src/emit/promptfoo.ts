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
import { DEFAULT_ENTRY, httpTransform } from "../core/target";
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
	config: Record<string, unknown>;
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

/**
 * Wraps an assert body that answers `true` or a sentence naming what is
 * wrong into what promptfoo accepts. promptfoo 0.123.0 takes a boolean, a
 * number or a GradingResult from a javascript assert and throws on a
 * string — the failure still counted, but its reason reached the report as
 * "Custom function threw error: ... Got type string", which hid every
 * difference. Measured on the second real target (2026-09-24): no assert
 * had failed on the first, so nothing had shown it.
 */
export function asGradingResult(body: string): string {
	return `const verdict = (() => {\n${body}\n})();\nreturn verdict === true ? true : { pass: false, score: 0, reason: String(verdict) };`;
}

function labelAssert(
	feature: Feature,
	label: string,
	featureFile: string,
): PromptfooAssert {
	const want = JSON.stringify(label);
	if (feature.output.kind === "label") {
		return {
			type: "javascript",
			value: asGradingResult(
				`const got = String(output).trim();\nreturn got === ${want} ? true : "output was " + JSON.stringify(got) + ", expected " + ${want};`,
			),
		};
	}
	if (feature.output.kind === "json") {
		const field = feature.output.label_field;
		if (!field)
			throw new ForgeError(
				"a label oracle on a json feature needs output.label_field",
				{ file: featureFile, id: feature.id },
			);
		const fieldLiteral = JSON.stringify(field);
		return {
			type: "javascript",
			value: asGradingResult(
				`${TOLERANT_PARSE}\nreturn obj[${fieldLiteral}] === ${want} ? true : ${fieldLiteral} + " was " + JSON.stringify(obj[${fieldLiteral}]) + ", expected " + ${want};`,
			),
		};
	}
	throw new ForgeError(
		"a label oracle cannot be checked against a text output",
		{ file: featureFile, id: feature.id },
	);
}

/**
 * Generated JavaScript, inlined into the emitted assert. Builds a list of
 * `differences` by comparing `want` against `obj`: a scalar field that
 * differs is named directly (one array entry); a list field is handed to
 * `compareItems`, which keys by a label-like field when every item carries
 * one and that label is unique on both sides, and falls back to comparing
 * by position (naming a length mismatch as its own entry) otherwise.
 *
 * The verdict never comes from this comparison: a list field passes only
 * when its JSON equals the expected JSON. Label mode reads only the keys the
 * expected item names and ignores order, so when it finds no item-level
 * difference for a list whose JSON differs, `fieldsAssert` pushes a fallback
 * entry saying so rather than letting the field pass.
 *
 * Each difference is pushed as its own array entry rather than pre-joined
 * with the "; " that later separates entries in the rendered reason: a
 * field's first entry carries the `field: ` prefix, later entries from the
 * same field do not. The five-item cap and the join happen once, on this
 * array, in `fieldsAssert` below — never by joining then re-splitting a
 * string, which corrupts any difference whose own value contains "; ".
 */
const FIELDS_DIFF = [
	"const differences = [];",
	"const show = (value) => JSON.stringify(value);",
	"const hasStringLabel = (item) => item !== null && typeof item === 'object' && typeof item.label === 'string';",
	"const hasDuplicateLabels = (items) => {",
	"  const seenLabels = new Set();",
	"  for (const item of items) {",
	"    if (!hasStringLabel(item)) continue;",
	"    if (seenLabels.has(item.label)) return true;",
	"    seenLabels.add(item.label);",
	"  }",
	// Stryker disable next-line StringLiteral: with the line emptied the emitted function falls off its end and answers undefined instead of false; its only use is `!hasDuplicateLabels(...)` inside `compareByLabel`, where undefined and false are the same.
	"  return false;",
	"};",
	"const compareByLabel = (wantItems, gotItems) => wantItems.length > 0 && wantItems.every(hasStringLabel) && !hasDuplicateLabels(wantItems) && !hasDuplicateLabels(gotItems);",
	"const compareItems = (name, gotItems, wantItems) => {",
	"  let isFirstPart = true;",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: this is generated JS source, not a template string of our own.
	"  const pushDifference = (text) => { differences.push(isFirstPart ? `${name}: ${text}` : text); isFirstPart = false; };",
	"  if (!compareByLabel(wantItems, gotItems)) {",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    if (gotItems.length !== wantItems.length) pushDifference(`${gotItems.length} items (expected ${wantItems.length})`);",
	"    for (let index = 0; index < Math.min(gotItems.length, wantItems.length); index++)",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"      if (show(gotItems[index]) !== show(wantItems[index])) pushDifference(`[${index}]=${show(gotItems[index])} (expected ${show(wantItems[index])})`);",
	"    return;",
	"  }",
	"  const gotByLabel = new Map(gotItems.filter(hasStringLabel).map((item) => [item.label, item]));",
	"  const wantLabels = new Set(wantItems.map((item) => item.label));",
	"  for (const wantItem of wantItems) {",
	"    const gotItem = gotByLabel.get(wantItem.label);",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    if (gotItem === undefined) { pushDifference(`missing ${show(wantItem.label)}`); continue; }",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    const fieldDifferences = Object.keys(wantItem).filter((field) => show(gotItem[field]) !== show(wantItem[field])).map((field) => `${field}=${show(gotItem[field])} (expected ${show(wantItem[field])})`);",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    if (fieldDifferences.length > 0) pushDifference(`${show(wantItem.label)} ${fieldDifferences.join(', ')}`);",
	"  }",
	"  for (const gotItem of gotItems) {",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    if (!hasStringLabel(gotItem)) pushDifference(`unexpected item ${show(gotItem)}`);",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: same — the backticks belong to the emitted assert, not to this file.
	"    else if (!wantLabels.has(gotItem.label)) pushDifference(`unexpected ${show(gotItem.label)}`);",
	"  }",
	"};",
].join("\n");

function fieldsAssert(fields: Record<string, unknown>): PromptfooAssert {
	const want = JSON.stringify(fields);
	return {
		type: "javascript",
		value: asGradingResult(
			`${TOLERANT_PARSE}\nconst want = ${want};\n${FIELDS_DIFF}\nfor (const field of Object.keys(want)) {\n  if (show(obj[field]) === show(want[field])) continue;\n  if (Array.isArray(obj[field]) && Array.isArray(want[field])) {\n    const partsBefore = differences.length;\n    compareItems(field, obj[field], want[field]);\n    if (differences.length === partsBefore) differences.push(\`\${field}: same items, but in a different order or with keys the expected value does not name\`);\n  } else differences.push(\`\${field}=\${show(obj[field])} (expected \${show(want[field])})\`);\n}\nif (differences.length === 0) return true;\nreturn "fields differ: " + (differences.length > 5 ? differences.slice(0, 5).join("; ") + \`; and \${differences.length - 5} more\` : differences.join("; "));`,
		),
	};
}

/**
 * Where an http suite puts the model a provider stands for. promptfoo sends
 * every provider of kind http the same request, so without this two target
 * models would be two identical runs. The forge substitutes it itself,
 * before writing the config, rather than leaving it for promptfoo to render:
 * it is not a var of any test.
 */
export const TARGET_MODEL_PLACEHOLDER = "{{target_model}}";

/** `value` with `replace` applied to every string inside it, recursively; keys are left alone. */
function mapStrings(
	value: unknown,
	replace: (text: string) => string,
): unknown {
	if (typeof value === "string") return replace(value);
	if (Array.isArray(value))
		return value.map((item) => mapStrings(item, replace));
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				mapStrings(item, replace),
			]),
		);
	return value;
}

/**
 * The warning emit prints when an http suite lists several target models
 * but `{{target_model}}` appears in none of url, headers or body: its
 * providers would all send the same request. Null when there is nothing
 * to warn about.
 */
export function httpTargetModelWarning(suite: Suite): string | null {
	const target = suite.target;
	if (target.kind !== "http" || target.models.length < 2) return null;
	let found = false;
	mapStrings([target.url, target.headers, target.body], (text) => {
		found = found || text.includes(TARGET_MODEL_PLACEHOLDER);
		return text;
	});
	if (found) return null;
	return `warning: target.kind is http and target.models lists ${target.models.length} models, but ${TARGET_MODEL_PLACEHOLDER} appears nowhere in target.url, target.headers or target.body, so every provider sends the same request`;
}

/**
 * The schema accepts `HTTP://` as it accepts `http://`; the emitted url
 * spells the scheme lower-case and leaves the host and path as written.
 */
function lowerCaseScheme(url: string): string {
	return url.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase());
}

function providerFor(
	model: string,
	suite: Suite,
	feature: Feature,
	command: string | undefined,
): PromptfooProvider {
	const target = suite.target;
	switch (target.kind) {
		case "python":
			return {
				id: `file://${target.entry ?? DEFAULT_ENTRY[target.kind]}`,
				label: model,
				config: target.python
					? { model, pythonExecutable: target.python }
					: { model },
			};
		case "javascript":
		case "typescript":
			return {
				id: `file://${target.entry ?? DEFAULT_ENTRY[target.kind]}`,
				label: model,
				config: { model },
			};
		case "exec":
			return { id: `exec: ${target.command}`, label: model, config: { model } };
		case "http": {
			const substitute = (text: string): string =>
				text.replaceAll(TARGET_MODEL_PLACEHOLDER, model);
			return {
				id: "http",
				label: model,
				config: {
					url: target.url && substitute(lowerCaseScheme(target.url)),
					method: target.method ?? "POST",
					headers: mapStrings(
						target.headers ?? { "Content-Type": "application/json" },
						substitute,
					),
					body: mapStrings(
						target.body ??
							Object.fromEntries(
								feature.inputs.map((input) => [
									input.name,
									`{{${input.name}}}`,
								]),
							),
						substitute,
					),
					transformResponse: httpTransform(target.response),
				},
			};
		}
		case "elixir":
		case "ruby":
		case "rust":
		case "go":
			if (command === undefined)
				throw new ForgeError(
					`no exec command for target.kind ${target.kind}; emit computes it from the project's files`,
				);
			return { id: `exec: ${command}`, label: model, config: { model } };
	}
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
			return suite.judges.map((judge) => ({
				type: "llm-rubric" as const,
				value: rubric,
				provider: toPromptfooProvider(judge),
			}));
		}
	}
}

export function buildPromptfooConfig(options: {
	feature: Feature;
	suite: Suite;
	selection: Selection;
	featureFile?: string;
	/** The exec command for the shim kinds that run through exec (elixir, ruby, rust, go). */
	command?: string;
}): PromptfooConfig {
	const { feature, suite, selection } = options;
	const featureFile = options.featureFile ?? "feature.yaml";
	if (selection.cases.length === 0)
		throw new ForgeError(
			"no approved case to emit; run `llm-tests-forge review` first",
			{
				file: featureFile,
			},
		);
	if (suite.target.kind === "http") {
		const colliding = feature.inputs.find(
			(input) => `{{${input.name}}}` === TARGET_MODEL_PLACEHOLDER,
		);
		if (colliding !== undefined)
			throw new ForgeError(
				`input "${colliding.name}" collides with the placeholder ${TARGET_MODEL_PLACEHOLDER}, which an http target replaces with each provider's model; rename the input`,
				{ file: featureFile, id: feature.id },
			);
	}
	const byId = new Map(
		selection.scenarios.map((scenario) => [scenario.id, scenario]),
	);
	const tests: PromptfooTest[] = selection.cases.map((emittedCase) => {
		const scenario = byId.get(emittedCase.scenario);
		// selectCases only returns cases of selected scenarios with an expected; both guards are for a hand-built Selection.
		if (!scenario)
			throw new ForgeError(
				`case ${emittedCase.id} names scenario "${emittedCase.scenario}", which is not selected`,
				{ id: emittedCase.id },
			);
		if (!emittedCase.expected)
			throw new ForgeError(`case ${emittedCase.id} has no expected`, {
				id: emittedCase.id,
			});
		return {
			description: emittedCase.id,
			metadata: {
				scenario: scenario.id,
				case: emittedCase.id,
				kind: scenario.kind,
				oracle: scenario.oracle,
			},
			vars: emittedCase.input,
			assert: assertsFor(
				emittedCase.id,
				emittedCase.expected,
				scenario,
				feature,
				suite,
				featureFile,
			),
		};
	});
	// promptfoo passes the rendered prompt to an exec command as its first argument, documented as the feature's first input, so exec keeps exactly that. Every other target reads its inputs from vars, never from this text: there the prompt is only what promptfoo's views show for a row, so it names every input.
	const prompt =
		suite.target.kind === "exec"
			? `{{${feature.inputs[0]?.name ?? "input"}}}`
			: feature.inputs
					.map((input) => `${input.name}: {{${input.name}}}`)
					.join("\n");
	return {
		description: `${feature.id}: forge suite, ${selection.cases.length} cases from ${selection.scenarios.length} scenarios`,
		prompts: [prompt],
		providers: suite.target.models.map((model) =>
			providerFor(model, suite, feature, options.command),
		),
		evaluateOptions: { repeat: suite.repeat },
		tests,
	};
}

export function renderPromptfooConfig(config: PromptfooConfig): string {
	return `# Written by llm-tests-forge emit; edit suite.yaml and re-run instead of editing this file.\n${stringify(config, { lineWidth: 0 })}`;
}
