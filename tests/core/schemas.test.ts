import { describe, expect, test } from "bun:test";
import type { Case, Feature, Scenario } from "../../src/core/schemas";
import {
	CaseSchema,
	FeatureSchema,
	PricesSchema,
	ProjectConfigSchema,
	ScenarioSchema,
	SuiteSchema,
} from "../../src/core/schemas";
import { RESPONSE_FUNCTION_REFUSAL } from "../../src/core/target";

describe("ProjectConfigSchema", () => {
	test("defaults may name several target models", () => {
		const config = {
			version: 1,
			language: "python",
			suites: [],
			defaults: { target_models: ["anthropic/claude-haiku-4-5", "m/x"] },
		} as const;
		expect(
			ProjectConfigSchema.parse(config).defaults.target_models,
		).toStrictEqual(["anthropic/claude-haiku-4-5", "m/x"]);
	});
});

const feature = {
	id: "classify-email",
	purpose: "Classify a hiring-process email",
	inputs: [{ name: "email", kind: "text", notes: "from, subject and body" }],
	output: {
		kind: "json",
		fields: ["type", "summary"],
		label_field: "type",
		labels: ["rejection", "unrelated"],
	},
	invariants: ["Answer is JSON only"],
	status: "pending",
} satisfies Feature;

describe("FeatureSchema", () => {
	test("accepts a full feature", () => {
		expect(FeatureSchema.parse(feature)).toEqual(feature);
	});
	test("defaults invariants to [] and rejects unknown status", () => {
		const { invariants: _i, ...noInv } = feature;
		expect(FeatureSchema.parse(noInv).invariants).toEqual([]);
		expect(
			FeatureSchema.safeParse({ ...feature, status: "rejected" }).success,
		).toBe(false);
	});
	test("label output requires labels", () => {
		expect(
			FeatureSchema.safeParse({ ...feature, output: { kind: "label" } })
				.success,
		).toBe(false);
		expect(
			FeatureSchema.safeParse({
				...feature,
				output: { kind: "label", labels: [] },
			}).success,
		).toBe(false);
		expect(
			FeatureSchema.safeParse({
				...feature,
				output: { kind: "label", labels: ["a", "b"] },
			}).success,
		).toBe(true);
	});
	test("a label output without labels is refused with a message saying what is missing", () => {
		const result = FeatureSchema.safeParse({
			...feature,
			output: { kind: "label" },
		});
		expect(
			result.error?.issues.map((issue) => [
				issue.path.join("."),
				issue.message,
			]),
		).toStrictEqual([
			["output", "output.kind 'label' requires a non-empty labels list"],
		]);
	});
	test("a feature may take several inputs, a json one among them, and give text", () => {
		const severalInputs = {
			...feature,
			inputs: [
				{ name: "email", kind: "text" },
				{ name: "application", kind: "json" },
			],
			output: { kind: "text" },
		} satisfies Feature;
		expect(FeatureSchema.parse(severalInputs)).toStrictEqual(severalInputs);
	});
});

describe("FeatureSchema: input names promptfoo's templates can reference", () => {
	/** The issues a feature whose only input is named `name` is refused with, as [path, message]. */
	function refusalsFor(name: string): string[][] | undefined {
		return FeatureSchema.safeParse({
			...feature,
			inputs: [{ name, kind: "text" }],
		}).error?.issues.map((issue) => [issue.path.join("."), issue.message]);
	}
	const refusal = (name: string): string[][] => [
		[
			"inputs.0.name",
			`input name "${name}" cannot be referenced in promptfoo's templates; use ASCII letters, digits and underscores, starting with a letter (a leading underscore is promptfoo's own), and none of not, true, false, none, null; rename it everywhere: in feature.yaml, in every case's input: keys, and in the target or shim code`,
		],
	];

	test("ASCII letters, digits and underscores, starting with a letter, are accepted, keywords in another case and the operators that render included", () => {
		for (const name of [
			"email",
			"body2",
			"Email_Body",
			"x",
			"NOT",
			"True",
			"None",
			"and",
			"or",
			"in",
			"is",
			"if",
		])
			expect(refusalsFor(name)).toBeUndefined();
	});
	test("a name with a space is refused, naming the input", () => {
		expect(refusalsFor("user message")).toStrictEqual(refusal("user message"));
	});
	test("a name with a hyphen (which promptfoo renders as a subtraction, NaN) is refused", () => {
		expect(refusalsFor("user-message")).toStrictEqual(refusal("user-message"));
	});
	test("a name starting with a digit is refused", () => {
		expect(refusalsFor("1st")).toStrictEqual(refusal("1st"));
	});
	test("a name with a letter outside ASCII is refused", () => {
		expect(refusalsFor("ünicode")).toStrictEqual(refusal("ünicode"));
	});
	test("a name ending in a character that is not a letter, digit or underscore is refused", () => {
		expect(refusalsFor("email.")).toStrictEqual(refusal("email."));
	});
	test("a name with a leading underscore is refused: promptfoo's own variables (__evalId, __repeatIndex, _conversation) would hand the target their value instead, and __proto__ is dropped on read", () => {
		for (const name of [
			"_private",
			"_",
			"__evalId",
			"__repeatIndex",
			"_conversation",
			"__proto__",
		])
			expect(refusalsFor(name)).toStrictEqual(refusal(name));
	});
	test("not, true, false, none and null, which promptfoo reads as a keyword or a literal, are refused", () => {
		for (const name of ["not", "true", "false", "none", "null"])
			expect(refusalsFor(name)).toStrictEqual(refusal(name));
	});
	test("an empty name is refused for being empty, not for its shape", () => {
		expect(refusalsFor("")?.map(([path]) => path)).toStrictEqual([
			"inputs.0.name",
		]);
		expect(refusalsFor("")?.[0]?.[1]).not.toContain("promptfoo");
	});
});

describe("ScenarioSchema", () => {
	test("requires kind and oracle from the enums", () => {
		const validScenario = {
			id: "polite-rejection",
			kind: "happy",
			oracle: "label",
			description: "a polite no",
			status: "pending",
		} satisfies Scenario;
		expect(ScenarioSchema.parse(validScenario)).toEqual(validScenario);
		expect(
			ScenarioSchema.safeParse({ ...validScenario, kind: "weird" }).success,
		).toBe(false);
		expect(
			ScenarioSchema.safeParse({ ...validScenario, oracle: "exact" }).success,
		).toBe(false);
	});
});

describe("CaseSchema", () => {
	test("expected is optional (imported cases) and duplicate_of is optional", () => {
		const caseInput = {
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "..." },
			status: "pending",
			generated_by: "google/gemini-3.5-flash",
		} satisfies Case;
		expect(CaseSchema.parse(caseInput)).toEqual(caseInput);
		const withExpected = {
			...caseInput,
			expected: { label: "rejection" },
			duplicate_of: "polite-rejection-02",
		} satisfies Case;
		expect(CaseSchema.parse(withExpected)).toEqual(withExpected);
	});
	test("expected must carry exactly one of label, fields, rubric", () => {
		const base = {
			id: "x-01",
			scenario: "x",
			input: { a: "b" },
			status: "pending",
			generated_by: "t",
		};
		expect(CaseSchema.safeParse({ ...base, expected: {} }).success).toBe(false);
		expect(
			CaseSchema.safeParse({ ...base, expected: { label: "a", rubric: "b" } })
				.success,
		).toBe(false);
		expect(
			CaseSchema.safeParse({
				...base,
				expected: { fields: { company: "Acme" } },
			}).success,
		).toBe(true);
	});
});

describe("SuiteSchema", () => {
	test("defaults repeat to 1 and include to []", () => {
		const parsedSuite = SuiteSchema.parse({
			target: {
				kind: "promptfoo-python",
				entry: "forge_target.py",
				models: ["anthropic/claude-haiku-4-5"],
			},
			judges: ["anthropic/claude-sonnet-5"],
		});
		expect(parsedSuite.repeat).toBe(1);
		expect(parsedSuite.include).toEqual([]);
	});
});

describe("SuiteSchema.target.kind", () => {
	test("target.kind takes the nine kinds, and the old promptfoo-python reads as python", () => {
		const base = { models: ["anthropic/claude-haiku-4-5"] };
		expect(
			SuiteSchema.parse({
				target: { ...base, kind: "promptfoo-python", entry: "forge_target.py" },
				judges: ["google/gemini-3.5-flash"],
			}).target.kind,
		).toBe("python");
		for (const kind of [
			"python",
			"javascript",
			"typescript",
			"elixir",
			"ruby",
			"rust",
			"go",
		] as const)
			expect(
				SuiteSchema.parse({
					target: { ...base, kind },
					judges: ["google/gemini-3.5-flash"],
				}).target.kind,
			).toBe(kind);
	});
	test("exec needs a command, http needs a url, and a response expression may not hold =>", () => {
		const judges = ["google/gemini-3.5-flash"];
		const models = ["m/x"];
		expect(() =>
			SuiteSchema.parse({ target: { kind: "exec", models }, judges }),
		).toThrow("target.command is required when target.kind is exec");
		expect(() =>
			SuiteSchema.parse({ target: { kind: "http", models }, judges }),
		).toThrow("target.url is required when target.kind is http");
		expect(() =>
			SuiteSchema.parse({
				target: {
					kind: "http",
					models,
					url: "http://localhost:1/x",
					response: "(json) => json.a",
				},
				judges,
			}),
		).toThrow("target.response must be an expression over json");
		expect(() =>
			SuiteSchema.parse({
				target: { kind: "http", models, url: "ftp://x" },
				judges,
			}),
		).toThrow("target.url must start with http:// or https://");
	});
	test("a target with several models, several judges and every optional field filled in parses as written", () => {
		const judges = ["google/gemini-3.5-flash", "anthropic/claude-sonnet-5"];
		const models = ["m/x", "m/y"];
		const exec = SuiteSchema.parse({
			target: { kind: "exec", models, command: "python run.py" },
			judges,
		});
		expect(exec.target.models).toStrictEqual(models);
		expect(exec.target.command).toBe("python run.py");
		expect(exec.judges).toStrictEqual(judges);
		const http = SuiteSchema.parse({
			target: {
				kind: "http",
				models,
				url: "https://localhost:1/classify",
				method: "POST",
				response: "json.output.label",
			},
			judges,
		});
		expect(http.target.method).toBe("POST");
		expect(http.target.response).toBe("json.output.label");
	});
	test("each target refusal is reported at the field it is about", () => {
		const judges = ["google/gemini-3.5-flash"];
		const models = ["m/x"];
		const refusals = (target: Record<string, unknown>) =>
			SuiteSchema.safeParse({ target, judges }).error?.issues.map((issue) => [
				issue.path.join("."),
				issue.message,
			]);
		expect(refusals({ kind: "exec", models })).toStrictEqual([
			["target.command", "target.command is required when target.kind is exec"],
		]);
		expect(refusals({ kind: "http", models })).toStrictEqual([
			["target.url", "target.url is required when target.kind is http"],
		]);
		expect(
			refusals({ kind: "http", models, url: "localhost:1/x" }),
		).toStrictEqual([
			["target.url", "target.url must start with http:// or https://"],
		]);
		expect(
			refusals({
				kind: "http",
				models,
				url: "http://localhost:1/x",
				body: null,
			}),
		).toStrictEqual([
			[
				"target.body",
				"target.body is null; remove the key to send one field per input",
			],
		]);
		expect(
			refusals({
				kind: "http",
				models,
				url: "http://localhost:1/x",
				response: " ",
			}),
		).toStrictEqual([["target.response", "target.response is empty"]]);
		expect(
			refusals({
				kind: "http",
				models,
				url: "http://localhost:1/x",
				response: "(json) => json.a",
			}),
		).toStrictEqual([["target.response", RESPONSE_FUNCTION_REFUSAL]]);
	});
	test("a url that only holds a scheme further along, not at its start, is refused", () => {
		expect(() =>
			SuiteSchema.parse({
				target: {
					kind: "http",
					models: ["m/x"],
					url: "www.example.com/login?next=https://example.com",
				},
				judges: ["google/gemini-3.5-flash"],
			}),
		).toThrow("target.url must start with http:// or https://");
	});
	test("the url scheme is matched without regard to case", () => {
		const parsed = SuiteSchema.parse({
			target: { kind: "http", models: ["m/x"], url: "HTTP://localhost:1/x" },
			judges: ["google/gemini-3.5-flash"],
		});
		expect(parsed.target.url).toBe("HTTP://localhost:1/x");
		expect(
			SuiteSchema.parse({
				target: { kind: "http", models: ["m/x"], url: "Https://localhost:1/x" },
				judges: ["google/gemini-3.5-flash"],
			}).target.url,
		).toBe("Https://localhost:1/x");
	});
	test("a response that is empty after trimming is refused", () => {
		for (const response of ["", "   ", "\n\t"])
			expect(() =>
				SuiteSchema.parse({
					target: {
						kind: "http",
						models: ["m/x"],
						url: "http://localhost:1/x",
						response,
					},
					judges: ["google/gemini-3.5-flash"],
				}),
			).toThrow("target.response is empty");
	});
	test("a null body is refused; an absent body is not", () => {
		const target = {
			kind: "http",
			models: ["m/x"],
			url: "http://localhost:1/x",
		};
		expect(() =>
			SuiteSchema.parse({
				target: { ...target, body: null },
				judges: ["google/gemini-3.5-flash"],
			}),
		).toThrow(
			"target.body is null; remove the key to send one field per input",
		);
		expect(
			SuiteSchema.parse({ target, judges: ["google/gemini-3.5-flash"] }).target
				.body,
		).toBeUndefined();
	});
});

describe("SuiteSchema.target.python", () => {
	test("is optional and, when present, a non-empty string", () => {
		const base = {
			target: {
				kind: "promptfoo-python",
				entry: "forge_target.py",
				models: ["anthropic/claude-haiku-4-5"],
			},
			judges: ["google/gemini-3.5-flash"],
		};
		expect(SuiteSchema.parse(base).target.python).toBeUndefined();
		expect(
			SuiteSchema.parse({
				...base,
				target: { ...base.target, python: ".venv/bin/python" },
			}).target.python,
		).toBe(".venv/bin/python");
		expect(
			SuiteSchema.safeParse({
				...base,
				target: { ...base.target, python: "" },
			}).success,
		).toBe(false);
	});
});

describe("PricesSchema", () => {
	const good = {
		updated: "2026-09-15",
		unit: "usd_per_million_tokens",
		sources: ["https://example.test/pricing"],
		models: { "anthropic/claude-haiku-4-5": { input: 1, output: 5 } },
	};
	test("accepts a dated table with at least one model", () => {
		expect(
			PricesSchema.parse(good).models["anthropic/claude-haiku-4-5"],
		).toEqual({
			input: 1,
			output: 5,
		});
	});
	test("rejects an empty models table", () => {
		const result = PricesSchema.safeParse({ ...good, models: {} });
		expect(result.success).toBe(false);
	});
	test("an empty models table is refused with a message saying so", () => {
		expect(
			PricesSchema.safeParse({ ...good, models: {} }).error?.issues.map(
				(issue) => issue.message,
			),
		).toStrictEqual(["models must list at least one model"]);
	});
	test("a table with no sources reads as one with an empty source list", () => {
		const { sources: _sources, ...withoutSources } = good;
		expect(PricesSchema.parse(withoutSources).sources).toStrictEqual([]);
	});
	test("rejects an updated field that is not YYYY-MM-DD", () => {
		expect(
			PricesSchema.safeParse({ ...good, updated: "15/09/2026" }).success,
		).toBe(false);
	});
	test("updated is the date alone: text before or after it is refused, and the message says the format", () => {
		for (const updated of ["2026-09-15T10:00:00Z", "on 2026-09-15"])
			expect(
				PricesSchema.safeParse({ ...good, updated }).error?.issues.map(
					(issue) => issue.message,
				),
			).toStrictEqual(["updated must be YYYY-MM-DD"]);
	});
	test("rejects a negative price", () => {
		expect(
			PricesSchema.safeParse({
				...good,
				models: { m: { input: -1, output: 5 } },
			}).success,
		).toBe(false);
	});
});
