import { describe, expect, test } from "bun:test";
import { ForgeError, UsageError } from "../../src/core/errors";

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
