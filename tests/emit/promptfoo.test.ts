import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import type { Case, Feature, Scenario, Suite } from "../../src/core/schemas";
import type { Selection } from "../../src/core/select";
import {
	buildPromptfooConfig,
	renderPromptfooConfig,
	TOLERANT_PARSE,
} from "../../src/emit/promptfoo";

const labelFeature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved",
};
const jsonFeature: Feature = {
	...labelFeature,
	output: {
		kind: "json",
		fields: ["type", "company"],
		label_field: "type",
		labels: ["rejection", "acknowledgement"],
	},
};
const suite: Suite = {
	target: {
		kind: "promptfoo-python",
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"],
		python: ".venv/bin/python",
	},
	judges: ["google/gemini-3.5-flash", "anthropic/claude-sonnet-5"],
	repeat: 2,
	include: [],
};
const sc = (
	id: string,
	kind: Scenario["kind"],
	oracle: Scenario["oracle"],
): Scenario => ({ id, kind, oracle, description: id, status: "approved" });
const cs = (
	id: string,
	scenario: string,
	expected: Case["expected"],
): Case => ({
	id,
	scenario,
	input: { email: `body of ${id}` },
	expected,
	status: "approved",
	generated_by: "t",
});

const selection: Selection = {
	scenarios: [
		sc("polite-rejection", "happy", "label"),
		sc("vague", "ambiguous", "rubric"),
	],
	cases: [
		cs("polite-rejection-01", "polite-rejection", { label: "rejection" }),
		cs("vague-01", "vague", { rubric: "says it is a receipt" }),
	],
	blockers: [],
};

/** Run an emitted javascript assert the way promptfoo does: as a function body with `output` in scope. */
function runAssert(body: string, output: string): true | string {
	return new Function("output", "context", body)(output, { vars: {} }) as
		| true
		| string;
}

describe("buildPromptfooConfig", () => {
	test("providers: one file:// provider per target model, labelled by the model, with the python path", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(cfg.providers).toEqual([
			{
				id: "file://forge_target.py",
				label: "anthropic/claude-haiku-4-5",
				config: {
					model: "anthropic/claude-haiku-4-5",
					pythonExecutable: ".venv/bin/python",
				},
			},
			{
				id: "file://forge_target.py",
				label: "google/gemini-3.5-flash",
				config: {
					model: "google/gemini-3.5-flash",
					pythonExecutable: ".venv/bin/python",
				},
			},
		]);
	});
	test("no python path in the suite → no pythonExecutable key at all", () => {
		const s: Suite = {
			...suite,
			target: { ...suite.target, python: undefined },
		};
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite: s,
			selection,
		});
		expect(cfg.providers[0]?.config).toEqual({
			model: "anthropic/claude-haiku-4-5",
		});
	});
	test("prompts, repeat and description", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(cfg.prompts).toEqual(["{{email}}"]);
		expect(cfg.evaluateOptions).toEqual({ repeat: 2 });
		expect(cfg.description).toBe(
			"classify-email: forge suite, 2 cases from 2 scenarios",
		);
	});
	test("each case becomes a test with its vars and full metadata", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(cfg.tests.map((t) => t.description)).toEqual([
			"polite-rejection-01",
			"vague-01",
		]);
		expect(cfg.tests[0]?.vars).toEqual({
			email: "body of polite-rejection-01",
		});
		expect(cfg.tests[0]?.metadata).toEqual({
			scenario: "polite-rejection",
			case: "polite-rejection-01",
			kind: "happy",
			oracle: "label",
		});
		expect(cfg.tests[1]?.metadata).toEqual({
			scenario: "vague",
			case: "vague-01",
			kind: "ambiguous",
			oracle: "rubric",
		});
	});
	test("a rubric case gets one llm-rubric assert per judge, same text, provider set per assert", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(cfg.tests[1]?.assert).toEqual([
			{
				type: "llm-rubric",
				value: "says it is a receipt",
				provider: "google:gemini-3.5-flash",
			},
			{
				type: "llm-rubric",
				value: "says it is a receipt",
				provider: "anthropic:messages:claude-sonnet-5",
			},
		]);
	});
	test("label oracle on a label-kind feature compares the trimmed output to the label", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		const a = cfg.tests[0]?.assert[0];
		expect(a?.type).toBe("javascript");
		expect(runAssert(a?.value ?? "", "rejection\n")).toBe(true);
		expect(runAssert(a?.value ?? "", "acknowledgement")).toBe(
			'output was "acknowledgement", expected rejection',
		);
	});
	test("label oracle on a json-kind feature reads label_field through the tolerant parser", () => {
		const cfg = buildPromptfooConfig({
			feature: jsonFeature,
			suite,
			selection,
		});
		const body = cfg.tests[0]?.assert[0]?.value ?? "";
		expect(body).toContain(TOLERANT_PARSE);
		expect(
			runAssert(body, '```json\n{"type": "rejection", "company": null}\n```'),
		).toBe(true);
		expect(runAssert(body, 'Sure! {"type": "offer"}')).toBe(
			'type was "offer", expected rejection',
		);
		expect(runAssert(body, "no json here")).toBe(
			"no JSON object in output: no json here",
		);
		expect(runAssert(body, "{not json}")).toMatch(/^output is not JSON: /);
	});
	test("fields oracle does a subset match and names every differing field", () => {
		const sel: Selection = {
			scenarios: [sc("f", "edge", "fields")],
			cases: [cs("f-01", "f", { fields: { company: "Acme", type: "offer" } })],
			blockers: [],
		};
		const cfg = buildPromptfooConfig({
			feature: jsonFeature,
			suite,
			selection: sel,
		});
		const body = cfg.tests[0]?.assert[0]?.value ?? "";
		expect(runAssert(body, '{"type":"offer","company":"Acme","extra":1}')).toBe(
			true,
		);
		expect(runAssert(body, '{"type":"rejection","company":"Acme"}')).toBe(
			'fields differ: type="rejection" (expected "offer")',
		);
	});
	test("a label containing a quote cannot break the snippet", () => {
		const sel: Selection = {
			scenarios: [sc("q", "edge", "label")],
			cases: [cs("q-01", "q", { label: 'say "hi"' })],
			blockers: [],
		};
		const f: Feature = {
			...labelFeature,
			output: { kind: "label", labels: ['say "hi"'] },
		};
		const body =
			buildPromptfooConfig({ feature: f, suite, selection: sel }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, 'say "hi"')).toBe(true);
	});
	test("label oracle on a json feature without label_field is a ForgeError naming output.label_field", () => {
		const f: Feature = {
			...jsonFeature,
			output: { kind: "json", fields: ["type"] },
		};
		expect(() =>
			buildPromptfooConfig({ feature: f, suite, selection }),
		).toThrow("output.label_field");
	});
	test("label oracle on a text feature is a ForgeError", () => {
		const f: Feature = { ...labelFeature, output: { kind: "text" } };
		expect(() =>
			buildPromptfooConfig({ feature: f, suite, selection }),
		).toThrow(ForgeError);
	});
	test("zero selected cases is a ForgeError (emit never writes an empty suite)", () => {
		expect(() =>
			buildPromptfooConfig({
				feature: labelFeature,
				suite,
				selection: { scenarios: [], cases: [], blockers: [] },
			}),
		).toThrow("no approved case");
	});
	test("a case naming a scenario that is not in the selection is a ForgeError (hand-built Selection guard)", () => {
		const sel: Selection = {
			scenarios: [sc("polite-rejection", "happy", "label")],
			cases: [cs("orphan-01", "not-selected", { label: "rejection" })],
			blockers: [],
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow(/orphan-01.*not selected/);
	});
	test("a case with no expected is a ForgeError naming the case (hand-built Selection guard)", () => {
		const sel: Selection = {
			scenarios: [sc("polite-rejection", "happy", "label")],
			cases: [
				{
					id: "bare-01",
					scenario: "polite-rejection",
					input: { email: "x" },
					status: "approved",
					generated_by: "t",
				},
			],
			blockers: [],
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow(/bare-01.*no expected/);
	});
});

describe("renderPromptfooConfig", () => {
	test("is YAML that parses back to the same object, with a header comment naming the forge", () => {
		const cfg = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		const text = renderPromptfooConfig(cfg);
		expect(
			text.startsWith(
				"# Written by forge emit; edit suite.yaml and re-run instead of editing this file.\n",
			),
		).toBe(true);
		expect(parse(text)).toEqual(cfg);
	});
});
