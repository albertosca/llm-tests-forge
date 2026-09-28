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
	test("every template the forge renders is embedded, and none is empty", () => {
		for (const name of [
			"describe",
			"scenarios",
			"cases",
			"dedupe",
			"shims/python",
		])
			expect(loadTemplate(name).length).toBeGreaterThan(100);
	});
	test("an unknown template name is refused by name", () => {
		expect(() => loadTemplate("nope")).toThrow("template not found (id: nope)");
	});
});
