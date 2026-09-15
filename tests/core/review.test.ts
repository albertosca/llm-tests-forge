import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import {
	applyDecision,
	pendingItems,
	withExpected,
} from "../../src/core/review";
import type { Case, Feature, Scenario } from "../../src/core/schemas";

const feature: Feature = {
	id: "f",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["a", "b"] },
	invariants: [],
	status: "pending",
};
const scn = (id: string, status: Scenario["status"]): Scenario => ({
	id,
	kind: "happy",
	oracle: "label",
	description: "d",
	status,
});
const cs = (
	id: string,
	scenario: string,
	status: Case["status"],
	duplicate_of?: string,
): Case => ({
	id,
	scenario,
	input: { email: id },
	expected: { label: "a" },
	status,
	generated_by: "t",
	...(duplicate_of ? { duplicate_of } : {}),
});

describe("pendingItems", () => {
	test("orders feature, scenarios, then cases grouped by scenario with duplicates after their original", () => {
		// s1-03 duplicates s1-01 but sits two slots away from it in file
		// order (s1-02 is in between) — a fixture where the duplicate was
		// already adjacent to its target would pass even if the reordering
		// step were a no-op, so it has to be moved for this test to mean
		// anything.
		const items = pendingItems(
			feature,
			[scn("s1", "approved"), scn("s2", "pending")],
			[
				cs("s1-01", "s1", "pending"),
				cs("s1-02", "s1", "pending"),
				cs("s1-03", "s1", "pending", "s1-01"),
				cs("s2-01", "s2", "approved"),
			],
		);
		expect(
			items.map((i) => (i.kind === "feature" ? "feature" : i.item.id)),
		).toEqual(["feature", "s2", "s1-01", "s1-03", "s1-02"]);
	});

	test("returns nothing when everything is reviewed", () => {
		expect(
			pendingItems(
				{ ...feature, status: "approved" },
				[scn("s1", "approved")],
				[cs("s1-01", "s1", "approved")],
			),
		).toEqual([]);
	});

	function caseIds(items: ReturnType<typeof pendingItems>): string[] {
		return items.filter((i) => i.kind === "case").map((i) => i.item.id);
	}

	test("a duplicate_of target missing from cases entirely keeps its own file-order position", () => {
		const items = pendingItems(
			feature,
			[],
			[
				cs("s1-01", "s1", "pending"),
				cs("s1-02", "s1", "pending", "does-not-exist"),
			],
		);
		expect(caseIds(items)).toEqual(["s1-01", "s1-02"]);
	});

	test("a duplicate_of target present but not pending keeps the duplicate at its own file-order position", () => {
		const items = pendingItems(
			feature,
			[],
			[cs("s1-01", "s1", "approved"), cs("s1-02", "s1", "pending", "s1-01")],
		);
		// s1-01 is not pending, so it never appears; s1-02 is still listed,
		// unmoved, since there is no pending target to sit next to.
		expect(caseIds(items)).toEqual(["s1-02"]);
	});

	test("two cases duplicating the same target are both placed after it, in their own relative order", () => {
		const items = pendingItems(
			feature,
			[],
			[
				cs("s1-01", "s1", "pending"),
				cs("s1-02", "s1", "pending"),
				cs("s1-03", "s1", "pending", "s1-01"),
				cs("s1-04", "s1", "pending", "s1-01"),
			],
		);
		expect(caseIds(items)).toEqual(["s1-01", "s1-03", "s1-04", "s1-02"]);
	});

	test("a duplicate-of-duplicate chain is single-hop only: the first link is not chased through the second (documented limitation)", () => {
		// A duplicates B, B duplicates C, file order [A, C, B] — the exact
		// shape that exposed the limitation now written into pendingItems's
		// docstring. B gets pulled to sit after C (satisfying B's own
		// adjacency, and coincidentally where it already was in file order),
		// but A is never re-chased to follow B once B has moved: A keeps its
		// own file-order slot instead of ending up next to B.
		const items = pendingItems(
			feature,
			[],
			[
				cs("A", "s1", "pending", "B"),
				cs("C", "s1", "pending"),
				cs("B", "s1", "pending", "C"),
			],
		);
		expect(caseIds(items)).toEqual(["A", "C", "B"]);
	});
});

describe("applyDecision", () => {
	test("approve, reject, skip", () => {
		expect(applyDecision(scn("s", "pending"), "approve").status).toBe(
			"approved",
		);
		expect(applyDecision(scn("s", "pending"), "reject").status).toBe(
			"rejected",
		);
		expect(applyDecision(scn("s", "pending"), "skip").status).toBe("pending");
	});

	test("a feature cannot be rejected", () => {
		let err: unknown;
		try {
			applyDecision(feature, "reject");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			"a feature cannot be rejected",
		);
	});

	test("edit validates the edited case and forces status edited", () => {
		const out = applyDecision(cs("c", "s", "pending"), "edit", {
			...cs("c", "s", "pending"),
			input: { email: "changed" },
		});
		expect(out.input.email).toBe("changed");
		expect(out.status).toBe("edited");

		let missingEditErr: unknown;
		try {
			applyDecision(cs("c", "s", "pending"), "edit");
		} catch (e) {
			missingEditErr = e;
		}
		expect(missingEditErr).toBeInstanceOf(ForgeError);
		expect((missingEditErr as ForgeError).message).toContain(
			"edit needs the edited item",
		);

		// A value that fails the schema has to reach applyDecision as genuinely
		// unknown data (the way a re-parsed YAML edit would), not as a cast
		// literal — JSON round-tripping produces that without `as any`/`as never`.
		const invalidEdit = JSON.parse(
			JSON.stringify({ ...cs("c", "s", "pending"), status: "weird" }),
		);
		let invalidEditErr: unknown;
		try {
			applyDecision(cs("c", "s", "pending"), "edit", invalidEdit);
		} catch (e) {
			invalidEditErr = e;
		}
		expect(invalidEditErr).toBeInstanceOf(ForgeError);
		expect((invalidEditErr as ForgeError).message).toContain("status");
	});

	test("edit also validates an edited scenario via the scenario schema", () => {
		const out = applyDecision(scn("s", "pending"), "edit", {
			...scn("s", "pending"),
			description: "changed",
		});
		expect(out.description).toBe("changed");
		expect(out.status).toBe("edited");

		const invalidEdit = JSON.parse(
			JSON.stringify({ ...scn("s", "pending"), kind: "weird" }),
		);
		let err: unknown;
		try {
			applyDecision(scn("s", "pending"), "edit", invalidEdit);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("kind");
	});

	test("edit also validates an edited feature via the feature schema", () => {
		const out = applyDecision(feature, "edit", {
			...feature,
			purpose: "changed",
		});
		expect(out.purpose).toBe("changed");
		expect(out.status).toBe("edited");

		const invalidEdit = JSON.parse(
			JSON.stringify({ ...feature, output: { kind: "weird" } }),
		);
		let err: unknown;
		try {
			applyDecision(feature, "edit", invalidEdit);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
	});

	test("an unrecognized decision throws instead of silently returning undefined", () => {
		// `Decision` has no zod schema behind it, so a caller holding an
		// unvalidated string (e.g. via `any`, the way `runReviewLoop` would
		// receive one from a buggy injected `ask`) can reach applyDecision
		// with a value outside the four literals. JSON round-tripping
		// produces that genuinely-unknown value without an `as any`/`as
		// never` cast.
		const bogus = JSON.parse(JSON.stringify("bogus"));
		let err: unknown;
		try {
			applyDecision(scn("s", "pending"), bogus);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain('"bogus"');
	});
});

describe("withExpected", () => {
	test("sets a valid expected and rejects an invalid one", () => {
		expect(
			withExpected(cs("c", "s", "pending"), { rubric: "r" }).expected,
		).toEqual({
			rubric: "r",
		});

		let err: unknown;
		try {
			withExpected(cs("c", "s", "pending"), {});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("exactly one of");
	});
});
