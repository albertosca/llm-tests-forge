import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import type { ReviewLoopResult } from "../../src/cli/review-loop";
import { runReviewLoop } from "../../src/cli/review-loop";
import { ForgeError } from "../../src/core/errors";
import type { PendingItem } from "../../src/core/review";
import type { Case, Feature, Scenario } from "../../src/core/schemas";

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

const feature: Feature = {
	id: "f",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["a", "b"] },
	invariants: [],
	status: "pending",
};
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
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
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
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
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
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
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

	test("an invalid edit re-asks the SAME item rather than abandoning it for the next one", async () => {
		// A single-item version of this test cannot tell "re-asked" apart
		// from "silently gave up and the loop just ended" — both leave the
		// first item undecided. With a second item present, the two
		// hypotheses diverge: re-asking keeps printing item 1's prompt
		// (twice) before item 2 ever appears; abandoning it would print
		// item 1 once, then jump straight to item 2.
		const edits = [
			stringify({ ...withExp, status: "weird" }),
			stringify({ ...withExp, input: { email: "edited" } }),
		];
		const printed: string[] = [];
		const r = await runReviewLoop({
			items: [
				{ kind: "case", item: withExp },
				{ kind: "scenario", item: scn },
			],
			ask: scripted(["edit", "edit", "approve"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});

		// indexOf/lastIndexOf would collapse the two identical item-1 headers
		// to the same position, so collect every matching index by hand.
		const item1Indices = printed
			.map((l, i) => (l === `--- case ${withExp.id} ---` ? i : -1))
			.filter((i) => i !== -1);
		const item2Indices = printed
			.map((l, i) => (l === `--- scenario ${scn.id} ---` ? i : -1))
			.filter((i) => i !== -1);
		expect(item1Indices.length).toBe(2);
		expect(item2Indices.length).toBe(1);
		expect(Math.max(...item1Indices)).toBeLessThan(Math.min(...item2Indices));

		expect(r.summary).toEqual({
			approved: 1,
			rejected: 0,
			edited: 1,
			skipped: 0,
		});
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
				checkExpected: () => null,
				takenIdsFor: () => new Set(),
				oracleOf: () => "label",
				print: () => {},
			}),
		).rejects.toThrow("boom");
	});

	test("an out-of-contract answer from ask() raises a named ForgeError instead of crashing anonymously", async () => {
		// Before the fix, this fed `applyDecision` a `Decision` outside its
		// switch, which fell through returning `undefined` and then crashed
		// at `current.id` with an anonymous `TypeError` — asserting only
		// "it threw" would pass in both the buggy and the fixed world, so
		// this pins the specific class and the message content instead.
		let err: unknown;
		try {
			await runReviewLoop({
				items: [{ kind: "scenario", item: scn }],
				ask: scripted(["yolo"]),
				openEditor: async (t) => t,
				askExpected: async () => ({ label: "x" }),
				checkExpected: () => null,
				takenIdsFor: () => new Set(),
				oracleOf: () => "label",
				print: () => {},
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect(err).not.toBeInstanceOf(TypeError);
		expect((err as ForgeError).message).toContain('"yolo"');
		expect((err as ForgeError).message).toContain(scn.id);
	});

	test("drives a feature item through a failed reject (which re-asks) then an approve", async () => {
		const printed: string[] = [];
		const r = await runReviewLoop({
			items: [{ kind: "feature", item: feature }],
			ask: scripted(["reject", "approve"]),
			openEditor: async (t) => t,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});
		expect(r.summary).toEqual({
			approved: 1,
			rejected: 0,
			edited: 0,
			skipped: 0,
		});
		expect(r.decisions).toEqual([
			{
				kind: "feature",
				originalId: feature.id,
				id: feature.id,
				item: { ...feature, status: "approved" },
			},
		]);
		expect(
			printed.some(
				(l) =>
					l.startsWith("cannot apply:") && l.includes("cannot be rejected"),
			),
		).toBe(true);
	});

	test("an edited expected outside the scenario's oracle is refused by name and the item is re-asked", async () => {
		// The prompt checks what it asks for, but $EDITOR is a second way
		// the same value arrives -- the rule has to hold on both.
		const edits = [
			stringify({ ...withExp, expected: { label: "not-a-label" } }),
			stringify({ ...withExp, expected: { label: "a" } }),
		];
		const printed: string[] = [];
		const r = await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["edit", "edit"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "a" }),
			checkExpected: (c) =>
				c.expected?.label === "a"
					? null
					: `label "${c.expected?.label}" is not one of the feature's labels`,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});

		expect(printed).toContain(
			`cannot apply: expected does not match the oracle: label "not-a-label" is not one of the feature's labels (id: ${withExp.id})`,
		);
		expect(r.summary.edited).toBe(1);
		expect(caseAt(r, 0).expected).toEqual({ label: "a" });
	});

	test("an edit renaming an item onto a sibling's id is refused by name and re-asked", async () => {
		const edits = [
			stringify({ ...scn, id: "already-taken" }),
			stringify({ ...scn, id: "free-id" }),
		];
		const printed: string[] = [];
		const r = await runReviewLoop({
			items: [{ kind: "scenario", item: scn }],
			ask: scripted(["edit", "edit"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set([scn.id, "already-taken"]),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});

		expect(printed).toContain(
			`cannot apply: id "already-taken" is already used by another item in the same file; pick an id nothing else uses (id: ${scn.id})`,
		);
		expect(r.decisions.map((d) => [d.originalId, d.id])).toEqual([
			[scn.id, "free-id"],
		]);
	});

	test("a refused decision leaves the item printed with the status it still has on disk", async () => {
		// The oracle refusal used to fire after `current` had already been
		// reassigned, so the retry printed `status: approved` for an item
		// that was still pending everywhere else.
		const printed: string[] = [];
		await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["approve"]),
			openEditor: async (t) => t,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => 'label "x" is not one of the feature\'s labels',
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (l) => printed.push(l),
		});

		expect(printed.filter((l) => l.includes("status: approved"))).toEqual([]);
		expect(printed.filter((l) => l.includes("status: pending")).length).toBe(2);
	});

	test("reports every decision to onDecided as it is taken, under the id the item had on entry, and reports nothing for a skip", async () => {
		const seen: [string, string, string][] = [];
		await runReviewLoop({
			items: [
				{ kind: "scenario", item: scn },
				{ kind: "case", item: withExp },
				{ kind: "case", item: noExp },
			],
			ask: scripted(["edit", "approve", "skip"]),
			openEditor: async () => stringify({ ...scn, id: "renamed" }),
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			onDecided: (kind, item, originalId) =>
				seen.push([kind, item.id, originalId]),
			print: () => {},
		});
		// The renamed scenario is reported under "s", the id the caller can
		// still find in the file it read; the skipped case is not reported.
		expect(seen).toEqual([
			["scenario", "renamed", "s"],
			["case", withExp.id, withExp.id],
		]);
	});

	test("skip leaves no decision", async () => {
		const r = await runReviewLoop({
			items: [{ kind: "scenario", item: scn }],
			ask: scripted(["skip"]),
			openEditor: async (t) => t,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: () => {},
		});
		expect(r.decisions).toEqual([]);
		expect(r.summary.skipped).toBe(1);
	});
});
