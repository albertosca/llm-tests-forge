import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import type { Selection } from "../../src/core/select";
import { renderCasesJsonl } from "../../src/emit/jsonl";

describe("renderCasesJsonl", () => {
	test("one object per case with id, scenario, kind, input and expected; trailing newline", () => {
		const selection: Selection = {
			scenarios: [
				{
					id: "a",
					kind: "happy",
					oracle: "label",
					description: "d",
					status: "approved",
				},
			],
			cases: [
				{
					id: "a-01",
					scenario: "a",
					input: { email: "x" },
					expected: { label: "rejection" },
					status: "approved",
					generated_by: "t",
				},
				{
					id: "a-02",
					scenario: "a",
					input: { email: "y" },
					expected: { label: "offer" },
					status: "edited",
					generated_by: "t",
					duplicate_of: "a-01",
				},
			],
			blockers: [],
			reviewable: 0,
		};
		// The exact text: one object per line, a newline between and after them,
		// so any consumer that reads line by line gets each case on its own.
		expect(renderCasesJsonl({ selection })).toBe(
			[
				'{"id":"a-01","scenario":"a","kind":"happy","input":{"email":"x"},"expected":{"label":"rejection"}}',
				'{"id":"a-02","scenario":"a","kind":"happy","input":{"email":"y"},"expected":{"label":"offer"}}',
				"",
			].join("\n"),
		);
	});
	test("a case whose scenario is not selected is a ForgeError naming the case and the scenario", () => {
		const selection: Selection = {
			scenarios: [],
			cases: [
				{
					id: "z-01",
					scenario: "z",
					input: {},
					expected: { label: "x" },
					status: "approved",
					generated_by: "t",
				},
			],
			blockers: [],
			reviewable: 0,
		};
		try {
			renderCasesJsonl({ selection });
			throw new Error("expected a ForgeError, but nothing was thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(ForgeError);
			expect((error as ForgeError).message).toBe(
				'case z-01 names scenario "z", which is not selected (id: z-01)',
			);
			expect((error as ForgeError).details).toEqual({ id: "z-01" });
		}
	});
});
