import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import type { Case, Feature, Scenario, Suite } from "../../src/core/schemas";
import { SuiteSchema } from "../../src/core/schemas";
import type { Selection } from "../../src/core/select";
import {
	buildPromptfooConfig,
	httpTargetModelWarning,
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
		kind: "python",
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"],
		python: ".venv/bin/python",
	},
	judges: ["google/gemini-3.5-flash", "anthropic/claude-sonnet-5"],
	repeat: 2,
	include: [],
};
const scenarioOf = (
	id: string,
	kind: Scenario["kind"],
	oracle: Scenario["oracle"],
): Scenario => ({ id, kind, oracle, description: id, status: "approved" });
const caseOf = (
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
		scenarioOf("polite-rejection", "happy", "label"),
		scenarioOf("vague", "ambiguous", "rubric"),
	],
	cases: [
		caseOf("polite-rejection-01", "polite-rejection", { label: "rejection" }),
		caseOf("vague-01", "vague", { rubric: "says it is a receipt" }),
	],
	blockers: [],
	reviewable: 0,
};

/** What promptfoo 0.123.0 accepts from a javascript assert that fails. */
interface Failure {
	pass: false;
	score: 0;
	reason: string;
}

/** Run an emitted javascript assert the way promptfoo does: as a function body with `output` in scope. */
function runAssert(body: string, output: string): true | Failure {
	return new Function("output", "context", body)(output, { vars: {} });
}

const failure = (reason: string): Failure => ({
	pass: false,
	score: 0,
	reason,
});

/** The reason of a failing result; a passing one has none. */
function reasonOf(result: true | Failure): string {
	return result === true ? "" : result.reason;
}

describe("buildPromptfooConfig", () => {
	test("each target kind emits the provider promptfoo 0.123 calls for it", () => {
		const withTarget = (target: Record<string, unknown>) => ({
			...suite,
			target: { models: ["anthropic/claude-haiku-4-5"], ...target },
		});
		const providerFor = (target: Record<string, unknown>, command?: string) =>
			buildPromptfooConfig({
				feature: jsonFeature,
				suite: SuiteSchema.parse(withTarget(target)),
				selection,
				command,
			}).providers[0];
		expect(providerFor({ kind: "python", python: ".venv/bin/python" })).toEqual(
			{
				id: "file://forge_target.py",
				label: "anthropic/claude-haiku-4-5",
				config: {
					model: "anthropic/claude-haiku-4-5",
					pythonExecutable: ".venv/bin/python",
				},
			},
		);
		expect(providerFor({ kind: "javascript" })?.id).toBe(
			"file://forge_target.mjs",
		);
		expect(providerFor({ kind: "typescript" })).toEqual({
			id: "file://forge_target.ts",
			label: "anthropic/claude-haiku-4-5",
			config: { model: "anthropic/claude-haiku-4-5" },
		});
		expect(providerFor({ kind: "ruby" }, "ruby forge_target.rb")).toEqual({
			id: "exec: ruby forge_target.rb",
			label: "anthropic/claude-haiku-4-5",
			config: { model: "anthropic/claude-haiku-4-5" },
		});
		expect(providerFor({ kind: "exec", command: "./run.sh" })?.id).toBe(
			"exec: ./run.sh",
		);
		expect(
			providerFor({
				kind: "http",
				url: "http://127.0.0.1:4000/extract",
				response: "json.result",
			}),
		).toEqual({
			id: "http",
			label: "anthropic/claude-haiku-4-5",
			config: {
				url: "http://127.0.0.1:4000/extract",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: Object.fromEntries(
					jsonFeature.inputs.map((input) => [input.name, `{{${input.name}}}`]),
				),
				transformResponse:
					'typeof (json.result) === "string" ? (json.result) : JSON.stringify(json.result)',
			},
		});
	});
	test("a shim kind that runs through exec, emitted without its command, is refused by name", () => {
		expect(() =>
			buildPromptfooConfig({
				feature: jsonFeature,
				suite: SuiteSchema.parse({
					...suite,
					target: { kind: "elixir", models: ["m/x"] },
				}),
				selection,
			}),
		).toThrow("no exec command for target.kind elixir");
	});
	test("an http target keeps its own method, headers and body", () => {
		const provider = buildPromptfooConfig({
			feature: jsonFeature,
			suite: SuiteSchema.parse({
				...suite,
				target: {
					kind: "http",
					models: ["m/x"],
					url: "http://127.0.0.1:1/x",
					method: "PUT",
					headers: { "X-Key": "1" },
					body: { text: "{{email}}" },
				},
			}),
			selection,
		}).providers[0];
		expect(provider?.config).toMatchObject({
			method: "PUT",
			headers: { "X-Key": "1" },
			body: { text: "{{email}}" },
		});
	});
	test("an http target gets each provider's model wherever {{target_model}} appears: url, a header, a nested body string", () => {
		const providers = buildPromptfooConfig({
			feature: jsonFeature,
			suite: SuiteSchema.parse({
				...suite,
				target: {
					kind: "http",
					models: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"],
					url: "http://127.0.0.1:1/x?model={{target_model}}",
					headers: { "X-Model": "{{target_model}}", "X-Key": "1" },
					body: {
						text: "{{email}}",
						options: { models: ["use {{target_model}} here"], retries: 2 },
					},
				},
			}),
			selection,
		}).providers;
		expect(providers.map((provider) => provider.config)).toMatchObject([
			{
				url: "http://127.0.0.1:1/x?model=anthropic/claude-haiku-4-5",
				headers: { "X-Model": "anthropic/claude-haiku-4-5", "X-Key": "1" },
				body: {
					text: "{{email}}",
					options: {
						models: ["use anthropic/claude-haiku-4-5 here"],
						retries: 2,
					},
				},
			},
			{
				url: "http://127.0.0.1:1/x?model=google/gemini-3.5-flash",
				headers: { "X-Model": "google/gemini-3.5-flash", "X-Key": "1" },
				body: {
					text: "{{email}}",
					options: { models: ["use google/gemini-3.5-flash here"], retries: 2 },
				},
			},
		]);
	});
	test("an http suite whose feature has an input named target_model is refused, naming the input and the placeholder", () => {
		const collidingFeature: Feature = {
			...labelFeature,
			inputs: [
				{ name: "email", kind: "text" },
				{ name: "target_model", kind: "text" },
			],
		};
		const httpSuite = SuiteSchema.parse({
			...suite,
			target: { kind: "http", models: ["m/x"], url: "http://127.0.0.1:1/x" },
		});
		expect(() =>
			buildPromptfooConfig({
				feature: collidingFeature,
				suite: httpSuite,
				selection,
			}),
		).toThrow(
			'input "target_model" collides with the placeholder {{target_model}}',
		);
		expect(() =>
			buildPromptfooConfig({
				feature: collidingFeature,
				suite,
				selection,
			}),
		).not.toThrow();
	});
	test("httpTargetModelWarning: several http models with no {{target_model}} anywhere warn; one model, the placeholder, or another kind do not", () => {
		const httpSuite = (target: Record<string, unknown>): Suite =>
			SuiteSchema.parse({
				...suite,
				target: { kind: "http", url: "http://127.0.0.1:1/x", ...target },
			});
		expect(httpTargetModelWarning(httpSuite({ models: ["m/a", "m/b"] }))).toBe(
			"warning: target.kind is http and target.models lists 2 models, but {{target_model}} appears nowhere in target.url, target.headers or target.body, so every provider sends the same request",
		);
		expect(httpTargetModelWarning(httpSuite({ models: ["m/a"] }))).toBeNull();
		expect(
			httpTargetModelWarning(
				httpSuite({
					models: ["m/a", "m/b"],
					body: { nested: ["{{target_model}}"] },
				}),
			),
		).toBeNull();
		expect(
			httpTargetModelWarning(
				httpSuite({
					models: ["m/a", "m/b"],
					headers: { "X-Model": "{{target_model}}" },
				}),
			),
		).toBeNull();
		expect(
			httpTargetModelWarning(
				httpSuite({
					models: ["m/a", "m/b"],
					url: "http://127.0.0.1:1/{{target_model}}",
				}),
			),
		).toBeNull();
		expect(httpTargetModelWarning(suite)).toBeNull();
	});
	test("providers: one file:// provider per target model, labelled by the model, with the python path", () => {
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(config.providers).toEqual([
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
		const customSuite: Suite = {
			...suite,
			target: { ...suite.target, python: undefined },
		};
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite: customSuite,
			selection,
		});
		expect(config.providers[0]?.config).toEqual({
			model: "anthropic/claude-haiku-4-5",
		});
	});
	test("prompts, repeat and description", () => {
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(config.prompts).toEqual(["{{email}}"]);
		expect(config.evaluateOptions).toEqual({ repeat: 2 });
		expect(config.description).toBe(
			"classify-email: forge suite, 2 cases from 2 scenarios",
		);
	});
	test("each case becomes a test with its vars and full metadata", () => {
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(config.tests.map((emittedTest) => emittedTest.description)).toEqual([
			"polite-rejection-01",
			"vague-01",
		]);
		expect(config.tests[0]?.vars).toEqual({
			email: "body of polite-rejection-01",
		});
		expect(config.tests[0]?.metadata).toEqual({
			scenario: "polite-rejection",
			case: "polite-rejection-01",
			kind: "happy",
			oracle: "label",
		});
		expect(config.tests[1]?.metadata).toEqual({
			scenario: "vague",
			case: "vague-01",
			kind: "ambiguous",
			oracle: "rubric",
		});
	});
	test("a rubric case gets one llm-rubric assert per judge, same text, provider set per assert", () => {
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		expect(config.tests[1]?.assert).toEqual([
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
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		const firstAssert = config.tests[0]?.assert[0];
		expect(firstAssert?.type).toBe("javascript");
		expect(runAssert(firstAssert?.value ?? "", "rejection\n")).toBe(true);
		expect(runAssert(firstAssert?.value ?? "", "acknowledgement")).toEqual(
			failure('output was "acknowledgement", expected rejection'),
		);
	});
	test("label oracle on a json-kind feature reads label_field through the tolerant parser", () => {
		const config = buildPromptfooConfig({
			feature: jsonFeature,
			suite,
			selection,
		});
		const body = config.tests[0]?.assert[0]?.value ?? "";
		expect(body).toContain(TOLERANT_PARSE);
		expect(
			runAssert(body, '```json\n{"type": "rejection", "company": null}\n```'),
		).toBe(true);
		expect(runAssert(body, 'Sure! {"type": "offer"}')).toEqual(
			failure('type was "offer", expected rejection'),
		);
		expect(runAssert(body, "no json here")).toEqual(
			failure("no JSON object in output: no json here"),
		);
		expect(reasonOf(runAssert(body, "{not json}"))).toMatch(
			/^output is not JSON: /,
		);
	});
	test("fields oracle does a subset match and names every differing field", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [
				caseOf("f-01", "f", { fields: { company: "Acme", type: "offer" } }),
			],
			blockers: [],
			reviewable: 0,
		};
		const config = buildPromptfooConfig({
			feature: jsonFeature,
			suite,
			selection: sel,
		});
		const body = config.tests[0]?.assert[0]?.value ?? "";
		expect(runAssert(body, '{"type":"offer","company":"Acme","extra":1}')).toBe(
			true,
		);
		expect(runAssert(body, '{"type":"rejection","company":"Acme"}')).toEqual(
			failure('fields differ: type="rejection" (expected "offer")'),
		);
	});
	test("a list field is compared item by item, keyed by label when the items carry one", () => {
		const questions = [
			{ label: "Name", kind: "text", options: [] },
			{ label: "Relocate?", kind: "single_select", options: ["Yes", "No"] },
			{ label: "Visa?", kind: "single_select", options: ["Yes", "No"] },
		];
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { questions } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		const got = [
			{ label: "Name", kind: "text", options: [] },
			{ label: "Relocate?", kind: "boolean", options: [] },
			{ label: "Start date", kind: "text", options: [] },
		];
		expect(runAssert(body, JSON.stringify({ questions: got }))).toEqual(
			failure(
				'fields differ: questions: "Relocate?" kind="boolean" (expected "single_select"), options=[] (expected ["Yes","No"]); missing "Visa?"; unexpected "Start date"',
			),
		);
		expect(runAssert(body, JSON.stringify({ questions }))).toBe(true);
	});
	test("an unexpected item that carries no label is named by its value, never as undefined", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { questions: [{ label: "a" }] } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		expect(
			runAssert(
				body,
				JSON.stringify({ questions: [{ label: "a" }, "stray", 7, null] }),
			),
		).toEqual(
			failure(
				'fields differ: questions: unexpected item "stray"; unexpected item 7; unexpected item null',
			),
		);
	});
	test("a list without a label-like key is compared by position, and a length difference is named", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { scores: [1, 2, 3] } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, JSON.stringify({ scores: [1, 5] }))).toEqual(
			failure(
				"fields differ: scores: 2 items (expected 3); [1]=5 (expected 2)",
			),
		);
	});
	test("more than five differences are counted rather than listed", () => {
		const want = Array.from({ length: 8 }, (_, index) => ({
			label: `q${index}`,
			kind: "text",
		}));
		const got = want.map((item) => ({ ...item, kind: "long_text" }));
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { questions: want } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		const reason = reasonOf(
			runAssert(body, JSON.stringify({ questions: got })),
		);
		expect(reason).toContain('"q4" kind="long_text" (expected "text")');
		expect(reason).not.toContain('"q5"');
		expect(reason).toEndWith("; and 3 more");
	});
	test("a semicolon-space inside a scalar value cannot be mistaken for the separator between differences", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { a: "1; 2; 3; 4", b: "y" } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		expect(
			runAssert(body, JSON.stringify({ a: "9; 8; 7; 6", b: "z" })),
		).toEqual(
			failure(
				'fields differ: a="9; 8; 7; 6" (expected "1; 2; 3; 4"); b="z" (expected "y")',
			),
		);
	});
	test("the five-item cap counts real differences, not pieces split out of values that contain the separator", () => {
		const want = {
			a: "1; 1",
			b: "2; 2",
			c: "3; 3",
			d: "4; 4",
			e: "5; 5",
			f: "6; 6",
		};
		const got = {
			a: "a; a",
			b: "b; b",
			c: "c; c",
			d: "d; d",
			e: "e; e",
			f: "f; f",
		};
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: want })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, JSON.stringify(got))).toEqual(
			failure(
				'fields differ: a="a; a" (expected "1; 1"); b="b; b" (expected "2; 2"); c="c; c" (expected "3; 3"); d="d; d" (expected "4; 4"); e="e; e" (expected "5; 5"); and 1 more',
			),
		);
	});
	test("duplicate labels in the expected list fall back to position, instead of collapsing under one map key", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [
				caseOf("f-01", "f", {
					fields: {
						items: [
							{ label: "Name", kind: "text" },
							{ label: "Name", kind: "boolean" },
						],
					},
				}),
			],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		const got = { items: [{ label: "Name", kind: "text" }] };
		expect(runAssert(body, JSON.stringify(got))).toEqual(
			failure("fields differ: items: 1 items (expected 2)"),
		);
	});
	test("duplicate labels in the output only also fall back to position", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [
				caseOf("f-01", "f", {
					fields: {
						items: [
							{ label: "Name", kind: "text" },
							{ label: "Age", kind: "number" },
						],
					},
				}),
			],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		const got = {
			items: [
				{ label: "Name", kind: "text" },
				{ label: "Name", kind: "text" },
			],
		};
		expect(runAssert(body, JSON.stringify(got))).toEqual(
			failure(
				'fields differ: items: [1]={"label":"Name","kind":"text"} (expected {"label":"Age","kind":"number"})',
			),
		);
	});
	describe("a list field passes only when its JSON equals the expected JSON; the item comparison only builds the reason", () => {
		const labelledItems = [
			{ label: "Name", kind: "text" },
			{ label: "Age", kind: "number" },
		];
		const labelledBody = (): string => {
			const labelledSelection: Selection = {
				scenarios: [scenarioOf("f", "edge", "fields")],
				cases: [caseOf("f-01", "f", { fields: { items: labelledItems } })],
				blockers: [],
				reviewable: 0,
			};
			return (
				buildPromptfooConfig({
					feature: jsonFeature,
					suite,
					selection: labelledSelection,
				}).tests[0]?.assert[0]?.value ?? ""
			);
		};
		const sameItemsReason =
			"fields differ: items: same items, but in a different order or with keys the expected value does not name";
		test("label mode: items in reverse order fail", () => {
			const got = { items: [...labelledItems].reverse() };
			expect(runAssert(labelledBody(), JSON.stringify(got))).toEqual(
				failure(sameItemsReason),
			);
		});
		test("label mode: an extra key on every item fails", () => {
			const got = {
				items: labelledItems.map((item) => ({ ...item, placeholder: "" })),
			};
			expect(runAssert(labelledBody(), JSON.stringify(got))).toEqual(
				failure(sameItemsReason),
			);
		});
		test("label mode: item keys in a different order fail", () => {
			const got = {
				items: labelledItems.map((item) => ({
					kind: item.kind,
					label: item.label,
				})),
			};
			expect(runAssert(labelledBody(), JSON.stringify(got))).toEqual(
				failure(sameItemsReason),
			);
		});
		test("positional mode (a repeated label): an extra key still fails with its positional reason", () => {
			const got = {
				items: [
					{ label: "Name", kind: "text", placeholder: "" },
					{ label: "Name", kind: "text", placeholder: "" },
				],
			};
			expect(runAssert(labelledBody(), JSON.stringify(got))).toEqual(
				failure(
					'fields differ: items: [0]={"label":"Name","kind":"text","placeholder":""} (expected {"label":"Name","kind":"text"}); [1]={"label":"Name","kind":"text","placeholder":""} (expected {"label":"Age","kind":"number"})',
				),
			);
		});
	});
	test("an equal-length positional list names only the index that differs", () => {
		const selection: Selection = {
			scenarios: [scenarioOf("f", "edge", "fields")],
			cases: [caseOf("f-01", "f", { fields: { scores: [1, 2, 3] } })],
			blockers: [],
			reviewable: 0,
		};
		const body =
			buildPromptfooConfig({ feature: jsonFeature, suite, selection }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, JSON.stringify({ scores: [1, 5, 3] }))).toEqual(
			failure("fields differ: scores: [1]=5 (expected 2)"),
		);
	});
	test("a label containing a quote cannot break the snippet", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("q", "edge", "label")],
			cases: [caseOf("q-01", "q", { label: 'say "hi"' })],
			blockers: [],
			reviewable: 0,
		};
		const feature: Feature = {
			...labelFeature,
			output: { kind: "label", labels: ['say "hi"'] },
		};
		const body =
			buildPromptfooConfig({ feature, suite, selection: sel }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, 'say "hi"')).toBe(true);
	});
	test("a label containing a backtick and a dollar-brace shape cannot break out of the emitted template literal", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal dollar-brace text is exactly what this test attacks with.
		const label = "say `hi` ${x}";
		const sel: Selection = {
			scenarios: [scenarioOf("bt", "edge", "label")],
			cases: [caseOf("bt-01", "bt", { label })],
			blockers: [],
			reviewable: 0,
		};
		const feature: Feature = {
			...labelFeature,
			output: { kind: "label", labels: [label] },
		};
		const body =
			buildPromptfooConfig({ feature, suite, selection: sel }).tests[0]
				?.assert[0]?.value ?? "";
		expect(runAssert(body, label)).toBe(true);
		expect(reasonOf(runAssert(body, "other"))).toContain(label);
	});
	test("label oracle on a json feature without label_field is a ForgeError naming output.label_field", () => {
		const feature: Feature = {
			...jsonFeature,
			output: { kind: "json", fields: ["type"] },
		};
		expect(() => buildPromptfooConfig({ feature, suite, selection })).toThrow(
			"output.label_field",
		);
	});
	test("label oracle on a text feature is a ForgeError", () => {
		const feature: Feature = { ...labelFeature, output: { kind: "text" } };
		expect(() => buildPromptfooConfig({ feature, suite, selection })).toThrow(
			ForgeError,
		);
	});
	test("zero selected cases is a ForgeError (emit never writes an empty suite)", () => {
		expect(() =>
			buildPromptfooConfig({
				feature: labelFeature,
				suite,
				selection: { scenarios: [], cases: [], blockers: [], reviewable: 0 },
			}),
		).toThrow("no approved case");
	});
	test("a case naming a scenario that is not in the selection is a ForgeError (hand-built Selection guard)", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("polite-rejection", "happy", "label")],
			cases: [caseOf("orphan-01", "not-selected", { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow(/orphan-01.*not selected/);
	});
	test("a label-oracle case whose expected has no label is a ForgeError, never a vacuous assert", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("polite-rejection", "happy", "label")],
			cases: [
				caseOf("polite-rejection-01", "polite-rejection", {
					fields: { type: "rejection" },
				}),
			],
			blockers: [],
			reviewable: 0,
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow(
			"case polite-rejection-01: oracle is label but expected.label is missing",
		);
	});
	test("a fields-oracle case whose expected has no fields is a ForgeError, never an empty want", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("shape", "happy", "fields")],
			cases: [caseOf("shape-01", "shape", { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		expect(() =>
			buildPromptfooConfig({ feature: jsonFeature, suite, selection: sel }),
		).toThrow("case shape-01: oracle is fields but expected.fields is missing");
	});
	test("a rubric-oracle case whose expected has no rubric is a ForgeError, never an empty rubric", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("vague", "ambiguous", "rubric")],
			cases: [caseOf("vague-01", "vague", { label: "rejection" })],
			blockers: [],
			reviewable: 0,
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow("case vague-01: oracle is rubric but expected.rubric is missing");
	});
	test("a case with no expected is a ForgeError naming the case (hand-built Selection guard)", () => {
		const sel: Selection = {
			scenarios: [scenarioOf("polite-rejection", "happy", "label")],
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
			reviewable: 0,
		};
		expect(() =>
			buildPromptfooConfig({ feature: labelFeature, suite, selection: sel }),
		).toThrow(/bare-01.*no expected/);
	});
});

describe("renderPromptfooConfig", () => {
	test("is YAML that parses back to the same object, with a header comment naming the forge", () => {
		const config = buildPromptfooConfig({
			feature: labelFeature,
			suite,
			selection,
		});
		const text = renderPromptfooConfig(config);
		expect(
			text.startsWith(
				"# Written by llm-tests-forge emit; edit suite.yaml and re-run instead of editing this file.\n",
			),
		).toBe(true);
		expect(parse(text)).toEqual(config);
	});
});
