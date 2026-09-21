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
function aCase(over: Partial<Case> & { id: string }): Case {
	return {
		scenario: "s",
		input: { email: "e" },
		expected: { label: "rejection" },
		status: "pending",
		generated_by: "hand",
		...over,
	};
}

describe("applyReviewDecisions: matching decisions to entries", () => {
	test("replaces the entry whose id on entry the decision was taken under", () => {
		const list = [aCase({ id: "s-01" }), aCase({ id: "s-02" })];
		const decidedCases = new Map([
			["s-01", aCase({ id: "s-01", status: "approved" })],
		]);
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(next.map((c) => c.status)).toEqual(["approved", "pending"]);
		expect(reopened).toBe(0);
		expect(touched).toBe(true);
	});

	test("a second entry under the same id keeps itself, decision taken once", () => {
		const list = [
			aCase({ id: "s-01", input: { email: "the first one" } }),
			aCase({ id: "s-01", input: { email: "the second one" } }),
		];
		const decidedCases = new Map([
			[
				"s-01",
				aCase({
					id: "s-01",
					input: { email: "the first one" },
					status: "approved",
				}),
			],
		]);
		const { next } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(next.map((c) => c.status)).toEqual(["approved", "pending"]);
		expect(next.map((c) => c.input.email)).toEqual([
			"the first one",
			"the second one",
		]);
		// Taken out of the map on first hit: a later entry under the same id
		// finds nothing and keeps itself.
		expect(decidedCases.size).toBe(0);
	});

	test("nothing matched and no oracle change leaves the list untouched", () => {
		const list = [aCase({ id: "s-01" }), aCase({ id: "s-02" })];
		const decidedCases = new Map([
			["other-01", aCase({ id: "other-01", status: "approved" })],
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
			aCase({ id: "s-01" }),
			aCase({ id: "s-02", duplicate_of: "s-01" }),
			aCase({ id: "s-03", duplicate_of: "s-99" }),
			aCase({ id: "s-04" }),
		];
		const decidedCases = new Map([
			["s-01", aCase({ id: "s-01-fixed", status: "edited" })],
		]);
		const { next, touched, renamed } = applyReviewDecisions({
			list,
			decidedCases,
			feature,
		});
		expect(next.map((c) => c.id)).toEqual([
			"s-01-fixed",
			"s-02",
			"s-03",
			"s-04",
		]);
		expect(next.map((c) => c.duplicate_of)).toEqual([
			undefined,
			"s-01-fixed",
			"s-99",
			undefined,
		]);
		expect([...renamed]).toEqual([["s-01", "s-01-fixed"]]);
		expect(touched).toBe(true);
	});

	test("a decided entry's own duplicate_of follows a rename decided in the same list", () => {
		const list = [aCase({ id: "s-01" }), aCase({ id: "s-02" })];
		const decidedCases = new Map([
			["s-01", aCase({ id: "s-01-fixed", status: "edited" })],
			["s-02", aCase({ id: "s-02", status: "approved", duplicate_of: "s-01" })],
		]);
		const { next } = applyReviewDecisions({ list, decidedCases, feature });
		expect(next[1]?.duplicate_of).toBe("s-01-fixed");
	});

	test("a rename applied in one list never rewrites a pointer in another list that spells the same id", () => {
		// Two files, each holding an entry `s-01` (a twin across files, which
		// review warns about) and a pointer at it. The decision is taken
		// once, by whichever list is walked first; the other list keeps
		// both its entry and its pointer, even when it has a decision of
		// its own and is written this pass.
		const listA = [
			aCase({ id: "s-01" }),
			aCase({ id: "s-02", duplicate_of: "s-01" }),
		];
		const listB = [
			aCase({ id: "s-01" }),
			aCase({ id: "t-01", duplicate_of: "s-01", status: "pending" }),
		];
		const decidedCases = new Map([
			["s-01", aCase({ id: "s-01-fixed", status: "edited" })],
			["t-01", aCase({ id: "t-01", duplicate_of: "s-01", status: "approved" })],
		]);
		const a = applyReviewDecisions({ list: listA, decidedCases, feature });
		const b = applyReviewDecisions({ list: listB, decidedCases, feature });
		expect(a.next.map((c) => [c.id, c.duplicate_of])).toEqual([
			["s-01-fixed", undefined],
			["s-02", "s-01-fixed"],
		]);
		expect(b.next.map((c) => [c.id, c.duplicate_of, c.status])).toEqual([
			["s-01", undefined, "pending"],
			["t-01", "s-01", "approved"],
		]);
		expect(b.touched).toBe(true);
		expect([...b.renamed]).toEqual([]);
	});
});

describe("applyReviewDecisions: an oracle change re-opens what no longer fits", () => {
	test("re-opens only mismatching approved and edited cases, keeping expected", () => {
		const list = [
			aCase({ id: "s-01", status: "approved" }),
			aCase({ id: "s-02", status: "edited" }),
			aCase({
				id: "s-03",
				status: "approved",
				expected: { rubric: "is polite" },
			}),
			aCase({ id: "s-04", status: "approved", expected: undefined }),
			aCase({ id: "s-05", status: "pending" }),
			aCase({ id: "s-06", status: "rejected" }),
		];
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases: new Map(),
			oracleChange: { from: "label", to: "rubric" },
			feature,
		});
		expect(next.map((c) => c.status)).toEqual([
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
			aCase({ id: "s-01", status: "approved" }),
			aCase({ id: "s-02", status: "pending" }),
		];
		const { next, reopened, touched } = applyReviewDecisions({
			list,
			decidedCases: new Map(),
			oracleChange: { from: "rubric", to: "label" },
			feature,
		});
		expect(next.map((c) => c.status)).toEqual(["approved", "pending"]);
		expect(reopened).toBe(0);
		expect(touched).toBe(false);
	});

	test("a re-opened case and a decision in the same file both land", () => {
		const list = [
			aCase({ id: "s-01", status: "approved" }),
			aCase({ id: "s-02", status: "pending" }),
		];
		const decidedCases = new Map([
			["s-02", aCase({ id: "s-02", status: "approved" })],
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
		expect(next.map((c) => c.status)).toEqual(["pending", "pending"]);
		expect(reopened).toBe(2);
		expect(touched).toBe(true);
	});
});
