import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";

describe("ForgeError", () => {
	test("message alone", () => {
		const e = new ForgeError("boom");
		expect(e.message).toBe("boom");
		expect(e.details).toEqual({});
		expect(e).toBeInstanceOf(Error);
	});

	test("appends file, id and raw path to the message", () => {
		const e = new ForgeError("bad label", {
			file: ".forge/cases/x.yaml",
			id: "x-01",
			rawPath: ".forge/failures/cases-1.txt",
		});
		expect(e.message).toBe(
			"bad label (file: .forge/cases/x.yaml, id: x-01, raw: .forge/failures/cases-1.txt)",
		);
		expect(e.details.id).toBe("x-01");
	});
});
