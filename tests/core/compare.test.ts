import { describe, expect, test } from "bun:test";
import { sameInput } from "../../src/core/compare";
import { CaseSchema } from "../../src/core/schemas";

describe("sameInput's premise: every input value is a string", () => {
	test("a case's input is strings only: the schema every case file and drafted case passes refuses any other value", () => {
		const withInput = (input: unknown) =>
			CaseSchema.safeParse({
				id: "a-01",
				scenario: "a",
				input,
				status: "pending",
				generated_by: "m/x",
			}).success;
		expect(withInput({ email: "x" })).toBe(true);
		for (const value of [undefined, null, 1, true, {}, ["x"]])
			expect(withInput({ email: value })).toBe(false);
	});

	test("a key the right side lacks never matches, even one that names an Object.prototype member, which reads as a function, not undefined", () => {
		expect(sameInput({ constructor: "x" }, { email: "x" })).toBe(false);
		expect(sameInput({ toString: "x" }, { email: "x" })).toBe(false);
	});
});

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

	test("one differing value among several shared keys is enough to be a different input", () => {
		expect(
			sameInput({ email: "x", subject: "y" }, { email: "x", subject: "z" }),
		).toBe(false);
	});

	test("the same key count under different names is not the same input", () => {
		expect(sameInput({ email: "x" }, { subject: "x" })).toBe(false);
	});

	test("key order does not matter", () => {
		expect(
			sameInput({ email: "x", subject: "y" }, { subject: "y", email: "x" }),
		).toBe(true);
	});
});
