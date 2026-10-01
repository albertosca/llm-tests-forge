import { describe, expect, test } from "bun:test";
import { ForgeError, messageOf, UsageError } from "../../src/core/errors";

describe("messageOf", () => {
	test("an error reads as its message, and a thrown value with none as itself", () => {
		expect(messageOf(new Error("disk full"))).toBe("disk full");
		expect(messageOf({ message: 42 })).toBe("42");
		expect(messageOf("the disk went away")).toBe("the disk went away");
		expect(messageOf(null)).toBe("null");
		expect(messageOf(undefined)).toBe("undefined");
	});

	test("a value that cannot be turned into text reads as a fixed sentence, never throws", () => {
		const unprintable = "a value that cannot be shown as text";
		const throwing = {
			toString(): string {
				throw new Error("no text for you");
			},
		};
		expect(messageOf(Object.create(null))).toBe(unprintable);
		expect(messageOf(throwing)).toBe(unprintable);
		expect(messageOf({ message: Object.create(null) })).toBe(unprintable);
		expect(messageOf({ message: throwing })).toBe(unprintable);
		expect(
			messageOf({
				get message(): string {
					throw new Error("no message for you");
				},
			}),
		).toBe(unprintable);
	});
});

describe("ForgeError", () => {
	test("an error that escapes reads as its own class in a trace: ForgeError, or UsageError for a bad command line", () => {
		expect(String(new ForgeError("boom"))).toBe("ForgeError: boom");
		expect(String(new UsageError("bad flag", { id: "--repeat" }))).toBe(
			"UsageError: bad flag (id: --repeat)",
		);
		expect(new UsageError("bad flag")).toBeInstanceOf(ForgeError);
	});

	test("message alone", () => {
		const error = new ForgeError("boom");
		expect(error.message).toBe("boom");
		expect(error.reason).toBe("boom");
		expect(error.details).toEqual({});
		expect(error).toBeInstanceOf(Error);
	});

	test("an empty-string detail is still present, not treated as absent", () => {
		expect(new ForgeError("m", { id: "" }).message).toBe("m (id: )");
		expect(new ForgeError("m", {}).message).toBe("m");
	});

	test("appends file, id and raw path to the message; the reason is the message without them", () => {
		const error = new ForgeError("bad label", {
			file: ".forge/cases/x.yaml",
			id: "x-01",
			rawPath: ".forge/failures/cases-1.txt",
		});
		expect(error.message).toBe(
			"bad label (file: .forge/cases/x.yaml, id: x-01, raw: .forge/failures/cases-1.txt)",
		);
		expect(error.reason).toBe("bad label");
		expect(error.details.id).toBe("x-01");
	});
});
