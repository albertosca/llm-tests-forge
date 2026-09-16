import { describe, expect, test } from "bun:test";
import { plural } from "../../src/core/text";

describe("plural", () => {
	test("one stays singular", () => {
		expect(plural(1, "case")).toBe("1 case");
	});
	test("zero takes the plural form", () => {
		expect(plural(0, "case")).toBe("0 cases");
	});
	test("more than one takes the plural form", () => {
		expect(plural(2, "case")).toBe("2 cases");
	});
	test("a multi-word noun pluralises the same way", () => {
		expect(plural(1, "target model")).toBe("1 target model");
		expect(plural(3, "target model")).toBe("3 target models");
	});
});
