import { describe, expect, test } from "bun:test";
import { applyReviewDecisions } from "../../src/cli/review-writeback";
import type { Case, Feature } from "../../src/core/schemas";

const feature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["rejection", "acknowledgement"] },
	invariants: [],
	status: "approved",
};

/** A pending case of scenario `s`, with a label expected the feature accepts. */
function caseWith(overrides: Partial<Case> & { id: string }): Case {
	return {
		scenario: "s",
		input: { email: "e" },
		expected: { label: "rejection" },
		status: "pending",
		generated_by: "hand",
		...overrides,
	};
}

/** The entry at `index`, failing loudly instead of handing back undefined. */
function entryAt(list: Case[], index: number): Case {
	const entry = list[index];
	if (entry === undefined) throw new Error(`no entry at index ${index}`);
	return entry;
}

describe("applyReviewDecisions: matching decisions to entries", () => {
	test("replaces the entry the decision was taken on", () => {
		const list = [caseWith({ id: "s-01" }), caseWith({ id: "s-02" })];
		const decidedCases = new Map([
			[entryAt(list, 0), caseWith({ id: "s-01", status: "approved" })],
		]);
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(next.map((caseEntry) => caseEntry.status)).toEqual([
			"approved",
			"pending",
		]);
		expect(reopened).toBe(0);
		expect(touched).toBe(true);
	});

	test("two entries under the same id: the decision lands on the one it was taken on, the other keeps itself", () => {
		const list = [
			caseWith({
				id: "s-01",
				input: { email: "the approved one" },
				status: "approved",
			}),
			caseWith({ id: "s-01", input: { email: "the pending twin" } }),
		];
		const decidedCases = new Map([
			[
				entryAt(list, 1),
				caseWith({
					id: "s-01",
					input: { email: "the pending twin" },
					status: "rejected",
				}),
			],
		]);
		const { next } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		// Matched by id, the decision replaced the approved first entry and
		// left the offered twin pending.
		expect(
			next.map((caseEntry) => [caseEntry.input.email, caseEntry.status]),
		).toEqual([
			["the approved one", "approved"],
			["the pending twin", "rejected"],
		]);
		// Taken out of the map on its hit, as every applied decision is.
		expect(decidedCases.size).toBe(0);
	});

	test("an equal entry that is not the one decided is left alone: the match is the entry, not its content", () => {
		const list = [caseWith({ id: "s-01" }), caseWith({ id: "s-01" })];
		const decidedCases = new Map([
			[entryAt(list, 1), caseWith({ id: "s-01", status: "approved" })],
		]);
		const { next } = applyReviewDecisions({ list, decidedCases, feature });
		expect(next.map((caseEntry) => caseEntry.status)).toEqual([
			"pending",
			"approved",
		]);
	});

	test("nothing matched and no oracle change leaves the list untouched", () => {
		const list = [caseWith({ id: "s-01" }), caseWith({ id: "s-02" })];
		const decidedCases = new Map([
			[
				caseWith({ id: "other-01" }),
				caseWith({ id: "other-01", status: "approved" }),
			],
		]);
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(touched).toBe(false);
		expect(reopened).toBe(0);
		expect(next).toEqual(list);
		expect(decidedCases.size).toBe(1);
	});
});

describe("applyReviewDecisions: duplicate_of follows a rename", () => {
	test("a decision that renames an entry rewrites the pointers to it, in this list only", () => {
		const list = [
			caseWith({ id: "s-01" }),
			caseWith({ id: "s-02", duplicate_of: "s-01" }),
			caseWith({ id: "s-03", duplicate_of: "s-99" }),
			caseWith({ id: "s-04" }),
		];
		const decidedCases = new Map([
			[entryAt(list, 0), caseWith({ id: "s-01-fixed", status: "edited" })],
		]);
		const { next, touched, renamed } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(next.map((caseEntry) => caseEntry.id)).toEqual([
			"s-01-fixed",
			"s-02",
			"s-03",
			"s-04",
		]);
		expect(next.map((caseEntry) => caseEntry.duplicate_of)).toEqual([
			undefined,
			"s-01-fixed",
			"s-99",
			undefined,
		]);
		expect([...renamed]).toEqual([["s-01", "s-01-fixed"]]);
		expect(touched).toBe(true);
	});

	test("a decided entry's own duplicate_of follows a rename decided in the same list", () => {
		const list = [caseWith({ id: "s-01" }), caseWith({ id: "s-02" })];
		const decidedCases = new Map([
			[entryAt(list, 0), caseWith({ id: "s-01-fixed", status: "edited" })],
			[
				entryAt(list, 1),
				caseWith({ id: "s-02", status: "approved", duplicate_of: "s-01" }),
			],
		]);
		const { next } = applyReviewDecisions({ list, decidedCases, feature });
		expect(next[1]?.duplicate_of).toBe("s-01-fixed");
	});

	test("a rename applied in one list never rewrites a pointer in another list that spells the same id", () => {
		// Two files, each holding an entry `s-01` (a twin across files, which
		// the review pass names) and a pointer at it. The decision belongs to
		// the first list's entry; the other list keeps both its entry and its
		// pointer, even when it has a decision of its own and is written
		// this pass.
		const firstList = [
			caseWith({ id: "s-01" }),
			caseWith({ id: "s-02", duplicate_of: "s-01" }),
		];
		const secondList = [
			caseWith({ id: "s-01" }),
			caseWith({ id: "t-01", duplicate_of: "s-01", status: "pending" }),
		];
		const decidedCases = new Map([
			[entryAt(firstList, 0), caseWith({ id: "s-01-fixed", status: "edited" })],
			[
				entryAt(secondList, 1),
				caseWith({ id: "t-01", duplicate_of: "s-01", status: "approved" }),
			],
		]);
		const first = applyReviewDecisions({
			list: firstList,
			decidedCases,
			feature,
		});
		const second = applyReviewDecisions({
			list: secondList,
			decidedCases,
			feature,
		});
		expect(
			first.next.map((caseEntry) => [caseEntry.id, caseEntry.duplicate_of]),
		).toEqual([
			["s-01-fixed", undefined],
			["s-02", "s-01-fixed"],
		]);
		expect(
			second.next.map((caseEntry) => [
				caseEntry.id,
				caseEntry.duplicate_of,
				caseEntry.status,
			]),
		).toEqual([
			["s-01", undefined, "pending"],
			["t-01", "s-01", "approved"],
		]);
		expect(second.touched).toBe(true);
		expect([...second.renamed]).toEqual([]);
	});
});

describe("applyReviewDecisions: an oracle change re-opens what no longer fits", () => {
	test("re-opens only mismatching approved and edited cases, keeping expected", () => {
		const list = [
			caseWith({ id: "s-01", status: "approved" }),
			caseWith({ id: "s-02", status: "edited" }),
			caseWith({
				id: "s-03",
				status: "approved",
				expected: { rubric: "is polite" },
			}),
			caseWith({ id: "s-04", status: "approved", expected: undefined }),
			caseWith({ id: "s-05", status: "pending" }),
			caseWith({ id: "s-06", status: "rejected" }),
		];
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases: new Map(),
			oracleChange: { from: "label", to: "rubric" },
			feature,
		});
		expect(next.map((caseEntry) => caseEntry.status)).toEqual([
			"pending",
			"pending",
			"approved",
			"pending",
			"pending",
			"rejected",
		]);
		// The reviewer's own answer is kept: only they can say what it
		// becomes under the new oracle.
		expect(next[0]?.expected).toEqual({ label: "rejection" });
		expect(reopened).toBe(3);
		expect(touched).toBe(true);
	});

	test("an oracle change whose cases all still fit touches nothing", () => {
		const list = [
			caseWith({ id: "s-01", status: "approved" }),
			caseWith({ id: "s-02", status: "pending" }),
		];
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases: new Map(),
			oracleChange: { from: "rubric", to: "label" },
			feature,
		});
		expect(next.map((caseEntry) => caseEntry.status)).toEqual([
			"approved",
			"pending",
		]);
		expect(reopened).toBe(0);
		expect(touched).toBe(false);
	});

	test("a re-opened case and a decision in the same file both land", () => {
		const list = [
			caseWith({ id: "s-01", status: "approved" }),
			caseWith({ id: "s-02", status: "pending" }),
		];
		const decidedCases = new Map([
			[entryAt(list, 1), caseWith({ id: "s-02", status: "approved" })],
		]);
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases,
			oracleChange: { from: "label", to: "rubric" },
			feature,
		});
		// The decision is applied before the re-open pass, so a case
		// approved in this very pass is re-opened by the same pass's
		// oracle change.
		expect(next.map((caseEntry) => caseEntry.status)).toEqual([
			"pending",
			"pending",
		]);
		expect(reopened).toBe(2);
		expect(touched).toBe(true);
	});
});
