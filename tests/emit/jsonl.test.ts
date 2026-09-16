import { describe, expect, test } from "bun:test";
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
		const text = renderCasesJsonl({ selection });
		expect(text.endsWith("\n")).toBe(true);
		expect(
			text
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l)),
		).toEqual([
			{
				id: "a-01",
				scenario: "a",
				kind: "happy",
				input: { email: "x" },
				expected: { label: "rejection" },
			},
			{
				id: "a-02",
				scenario: "a",
				kind: "happy",
				input: { email: "y" },
				expected: { label: "offer" },
			},
		]);
	});
	test("a case whose scenario is not selected is a ForgeError naming the case", () => {
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
		expect(() => renderCasesJsonl({ selection })).toThrow("z-01");
	});
});
