import { describe, expect, test } from "bun:test";
import { loadTemplate, render } from "../../src/llm/templates";

describe("render", () => {
	test("replaces every placeholder", () => {
		expect(
			render("Hi {{name}}, {{name}} again: {{thing}}", {
				name: "A",
				thing: "B",
			}),
		).toBe("Hi A, A again: B");
	});
	test("throws on a placeholder without a value", () => {
		expect(() => render("{{missing}}", {})).toThrow(
			'placeholder "{{missing}}" has no value',
		);
	});
});

describe("loadTemplate", () => {
	test("every template the forge renders is embedded, and is its own text", () => {
		const signatures: Record<string, string> = {
			describe: "{{description}}",
			scenarios: "{{coverage}}",
			cases: "{{input_names}}",
			dedupe: "{{cases}}",
			"shims/python": "def call_api",
		};
		for (const [name, signature] of Object.entries(signatures)) {
			expect(loadTemplate(name).length).toBeGreaterThan(100);
			expect(loadTemplate(name)).toContain(signature);
		}
	});
	test("an unknown template name is refused by name", () => {
		expect(() => loadTemplate("nope")).toThrow("template not found (id: nope)");
	});
});
