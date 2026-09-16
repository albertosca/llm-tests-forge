import { describe, expect, test } from "bun:test";
import { parsePositiveIntFlag } from "../../src/cli/flags";
import { UsageError } from "../../src/core/errors";

describe("parsePositiveIntFlag", () => {
	test("undefined stays undefined -- the flag was not passed", () => {
		expect(parsePositiveIntFlag("--n", undefined)).toBeUndefined();
	});

	test("a valid positive integer string parses to a number", () => {
		expect(parsePositiveIntFlag("--n", "3")).toBe(3);
	});

	test("zero is rejected: a UsageError naming the flag and the value", () => {
		const err = (() => {
			try {
				parsePositiveIntFlag("--n", "0");
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).message).toContain("--n");
		expect((err as UsageError).message).toContain("0");
	});

	test("a negative integer is rejected: a UsageError naming the flag and the value", () => {
		const err = (() => {
			try {
				parsePositiveIntFlag("--more", "-1");
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).message).toContain("--more");
		expect((err as UsageError).message).toContain("-1");
	});

	test("a non-numeric string is rejected: a UsageError naming the flag and the value", () => {
		const err = (() => {
			try {
				parsePositiveIntFlag("--n", "x");
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).message).toContain("--n");
		expect((err as UsageError).message).toContain("x");
	});

	test("a non-integer number is rejected: a UsageError naming the flag and the value", () => {
		const err = (() => {
			try {
				parsePositiveIntFlag("--n", "1.5");
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(UsageError);
		expect((err as UsageError).message).toContain("--n");
		expect((err as UsageError).message).toContain("1.5");
	});
});
