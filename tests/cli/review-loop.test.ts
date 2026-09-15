import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import type { ReviewLoopResult } from "../../src/cli/review-loop";
import { runReviewLoop } from "../../src/cli/review-loop";
import type { PendingItem } from "../../src/core/review";
import type { Case, Scenario } from "../../src/core/schemas";

/**
 * Pulls the case out of a decided item at `i`, failing loudly if the loop
 * did not actually record a decision there — avoids `?.` chained straight
 * into a cast, which would silently produce `undefined` at runtime instead
 * of failing the assertion that follows.
 */
function caseAt(r: ReviewLoopResult, i: number): Case {
	const d = r.decisions[i];
	if (!d) throw new Error(`expected a decision at index ${i}`);
	return d.item as Case;
}

const scn: Scenario = {
	id: "s",
	kind: "happy",
	oracle: "label",
	description: "d",
	status: "pending",
};
const withExp: Case = {
	id: "s-01",
	scenario: "s",
	input: { email: "a" },
	expected: { label: "x" },
	status: "pending",
	generated_by: "t",
};
const noExp: Case = {
	id: "imported-01",
	scenario: "imported",
	input: { email: "b" },
	status: "pending",
	generated_by: "import:f",
};

function scripted(answers: string[]) {
	const queue = [...answers];
	return async () => queue.shift() ?? "skip";
}

describe("runReviewLoop", () => {
	test("applies scripted decisions and counts them", async () => {
		const items: PendingItem[] = [
			{ kind: "scenario", item: scn },
			{ kind: "case", item: withExp },
		];
		const printed: string[] = [];
		const r = await runReviewLoop({
			items,
			ask: scripted(["approve", "reject"]),
			openEditor: async (t) => t,
			askExpected: async () => ({ label: "x" }),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});
		expect(r.summary).toEqual({
			approved: 1,
			rejected: 1,
			edited: 0,
			skipped: 0,
		});
		expect(r.decisions.map((d) => [d.id, d.item.status])).toEqual([
			["s", "approved"],
			["s-01", "rejected"],
		]);
		expect(printed.join("\n")).toContain("id: s-01");
	});

	test("asks for expected before approving a case that has none", async () => {
		let asked = 0;
		const r = await runReviewLoop({
			items: [{ kind: "case", item: noExp }],
			ask: scripted(["approve"]),
			openEditor: async (t) => t,
			askExpected: async () => {
				asked += 1;
				return { label: "rejection" };
			},
			oracleOf: () => "label",
			print: () => {},
		});
		expect(asked).toBe(1);
		expect(caseAt(r, 0).expected).toEqual({
			label: "rejection",
		});
	});

	test("asks for expected before editing a case that has none, and the editor sees it filled in", async () => {
		let asked = 0;
		let editorSawExpected: unknown;
		const r = await runReviewLoop({
			items: [{ kind: "case", item: noExp }],
			ask: scripted(["edit"]),
			openEditor: async (yamlText) => {
				editorSawExpected = parse(yamlText).expected;
				return yamlText;
			},
			askExpected: async () => {
				asked += 1;
				return { label: "rejection" };
			},
			oracleOf: () => "label",
			print: () => {},
		});
		expect(asked).toBe(1);
		expect(editorSawExpected).toEqual({ label: "rejection" });
		expect(r.summary.edited).toBe(1);
		expect(caseAt(r, 0).expected).toEqual({
			label: "rejection",
		});
		expect(caseAt(r, 0).status).toBe("edited");
	});

	test("edit round-trips through the editor and an invalid edit re-asks", async () => {
		const edits = [
			stringify({ ...withExp, status: "weird" }),
			stringify({ ...withExp, input: { email: "edited" } }),
		];
		const r = await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["edit", "edit"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "x" }),
			oracleOf: () => "label",
			print: () => {},
		});
		expect(r.summary.edited).toBe(1);
		expect(caseAt(r, 0).input.email).toBe("edited");
	});

	test("a non-ForgeError raised while applying a decision propagates instead of being retried", async () => {
		await expect(
			runReviewLoop({
				items: [{ kind: "case", item: noExp }],
				ask: scripted(["approve"]),
				openEditor: async (t) => t,
				askExpected: async () => {
					throw new Error("boom");
				},
				oracleOf: () => "label",
				print: () => {},
			}),
		).rejects.toThrow("boom");
	});

	test("skip leaves no decision", async () => {
		const r = await runReviewLoop({
			items: [{ kind: "scenario", item: scn }],
			ask: scripted(["skip"]),
			openEditor: async (t) => t,
			askExpected: async () => ({ label: "x" }),
			oracleOf: () => "label",
			print: () => {},
		});
		expect(r.decisions).toEqual([]);
		expect(r.summary.skipped).toBe(1);
	});
});
