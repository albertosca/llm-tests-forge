import { describe, expect, test } from "bun:test";
import { sameInput } from "../../src/core/compare";

describe("sameInput", () => {
	test("two objects with the same keys and values are the same input", () => {
		expect(sameInput({ email: "x" }, { email: "x" })).toBe(true);
	});

	test("a different value for a shared key is not the same input", () => {
		expect(sameInput({ email: "x" }, { email: "y" })).toBe(false);
	});

	test("a different key set is not the same input, even with overlapping values", () => {
		expect(sameInput({ email: "x" }, { email: "x", subject: "y" })).toBe(false);
	});

	test("key order does not matter", () => {
		expect(
			sameInput({ email: "x", subject: "y" }, { subject: "y", email: "x" }),
		).toBe(true);
	});
});
