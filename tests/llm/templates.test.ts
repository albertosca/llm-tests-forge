import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
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
	test("reads templates/<name>.md from the package root", async () => {
		const text = await loadTemplate("describe");
		expect(text).toContain("{{description}}");
	});
	test("throws ForgeError naming the file when absent", async () => {
		const err = await loadTemplate("nope").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("nope.md");
	});
	test("loadTemplate takes an extension, defaulting to md", async () => {
		const py = await loadTemplate("forge_target", "py");
		expect(py).toContain("def call_api");
		const md = await loadTemplate("describe");
		expect(md.length).toBeGreaterThan(0);
	});
});
