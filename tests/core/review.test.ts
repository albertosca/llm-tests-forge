import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import {
	applyDecision,
	pendingItemFor,
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
const makeScenario = (id: string, status: Scenario["status"]): Scenario => ({
	id,
	kind: "happy",
	oracle: "label",
	description: "d",
	status,
});
const makeCase = (
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
			[makeScenario("s1", "approved"), makeScenario("s2", "pending")],
			[
				makeCase("s1-01", "s1", "pending"),
				makeCase("s1-02", "s1", "pending"),
				makeCase("s1-03", "s1", "pending", "s1-01"),
				makeCase("s2-01", "s2", "approved"),
			],
		);
		expect(
			items.map((entry) =>
				entry.kind === "feature" ? "feature" : entry.item.id,
			),
		).toEqual(["feature", "s2", "s1-01", "s1-03", "s1-02"]);
	});

	test("returns nothing when everything is reviewed", () => {
		expect(
			pendingItems(
				{ ...feature, status: "approved" },
				[makeScenario("s1", "approved")],
				[makeCase("s1-01", "s1", "approved")],
			),
		).toEqual([]);
	});

	function caseIds(items: ReturnType<typeof pendingItems>): string[] {
		return items
			.filter((entry) => entry.kind === "case")
			.map((entry) => entry.item.id);
	}

	test("a duplicate_of target missing from cases entirely keeps its own file-order position", () => {
		const items = pendingItems(
			feature,
			[],
			[
				makeCase("s1-01", "s1", "pending"),
				makeCase("s1-02", "s1", "pending", "does-not-exist"),
			],
		);
		expect(caseIds(items)).toEqual(["s1-01", "s1-02"]);
	});

	test("a duplicate_of target present but not pending keeps the duplicate at its own file-order position", () => {
		const items = pendingItems(
			feature,
			[],
			[
				makeCase("s1-01", "s1", "approved"),
				makeCase("s1-02", "s1", "pending", "s1-01"),
			],
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
				makeCase("s1-01", "s1", "pending"),
				makeCase("s1-02", "s1", "pending"),
				makeCase("s1-03", "s1", "pending", "s1-01"),
				makeCase("s1-04", "s1", "pending", "s1-01"),
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
				makeCase("A", "s1", "pending", "B"),
				makeCase("C", "s1", "pending"),
				makeCase("B", "s1", "pending", "C"),
			],
		);
		expect(caseIds(items)).toEqual(["A", "C", "B"]);
	});

	test("a case listed before the case it duplicates is asked about once, not again after its target", () => {
		const items = pendingItems(
			feature,
			[],
			[
				makeCase("s1-01", "s1", "pending", "s1-02"),
				makeCase("s1-02", "s1", "pending"),
			],
		);
		expect(caseIds(items)).toStrictEqual(["s1-01", "s1-02"]);
	});

	test("each item comes with its kind: the feature, then scenarios, then cases", () => {
		const items = pendingItems(
			feature,
			[makeScenario("s1", "pending")],
			[makeCase("s1-01", "s1", "pending")],
		);
		expect(items.map((entry) => [entry.kind, entry.item.id])).toStrictEqual([
			["feature", "f"],
			["scenario", "s1"],
			["case", "s1-01"],
		]);
	});
});

describe("pendingItemFor", () => {
	test("pairs a decided feature, scenario or case with its own kind", () => {
		const scenario = makeScenario("s1", "approved");
		const kase = makeCase("s1-01", "s1", "edited");
		expect(pendingItemFor(feature)).toStrictEqual({
			kind: "feature",
			item: feature,
		});
		expect(pendingItemFor(scenario)).toStrictEqual({
			kind: "scenario",
			item: scenario,
		});
		expect(pendingItemFor(kase)).toStrictEqual({ kind: "case", item: kase });
	});
});

describe("applyDecision", () => {
	test("approve, reject, skip", () => {
		expect(applyDecision(makeScenario("s", "pending"), "approve").status).toBe(
			"approved",
		);
		expect(applyDecision(makeScenario("s", "pending"), "reject").status).toBe(
			"rejected",
		);
		expect(applyDecision(makeScenario("s", "pending"), "skip").status).toBe(
			"pending",
		);
	});

	test("a feature cannot be rejected", () => {
		let caught: unknown;
		try {
			applyDecision(feature, "reject");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			"a feature cannot be rejected; edit it or delete .forge/feature.yaml (id: f)",
		);
	});

	test("edit validates the edited case and forces status edited", () => {
		const out = applyDecision(makeCase("c", "s", "pending"), "edit", {
			...makeCase("c", "s", "pending"),
			input: { email: "changed" },
		});
		expect(out.input.email).toBe("changed");
		expect(out.status).toBe("edited");

		let missingEditError: unknown;
		try {
			applyDecision(makeCase("c", "s", "pending"), "edit");
		} catch (error) {
			missingEditError = error;
		}
		expect(missingEditError).toBeInstanceOf(ForgeError);
		expect((missingEditError as ForgeError).message).toBe(
			"edit needs the edited item (id: c)",
		);

		// A value that fails the schema has to reach applyDecision as genuinely
		// unknown data (the way a re-parsed YAML edit would), not as a cast
		// literal — JSON round-tripping produces that without `as any`/`as never`.
		const invalidEdit = JSON.parse(
			JSON.stringify({ ...makeCase("c", "s", "pending"), status: "weird" }),
		);
		let invalidEditError: unknown;
		try {
			applyDecision(makeCase("c", "s", "pending"), "edit", invalidEdit);
		} catch (error) {
			invalidEditError = error;
		}
		expect(invalidEditError).toBeInstanceOf(ForgeError);
		expect((invalidEditError as ForgeError).message).toContain("status");
	});

	test("an invalid edit names each field that broke, nested fields by their dotted path, and the item", () => {
		const invalidEdit = JSON.parse(
			JSON.stringify({
				...makeCase("c", "s", "pending"),
				input: { email: 3 },
				status: "weird",
			}),
		);
		expect(() =>
			applyDecision(makeCase("c", "s", "pending"), "edit", invalidEdit),
		).toThrow(
			'edited item is invalid: input.email: Invalid input: expected string, received number; status: Invalid option: expected one of "pending"|"approved"|"rejected"|"edited" (id: c)',
		);
	});

	test("edit refuses to move a case to another scenario, and names the move command", () => {
		expect(() =>
			applyDecision(makeCase("s1-01", "s1", "pending"), "edit", {
				...makeCase("s1-01", "s1", "pending"),
				scenario: "s2",
			}),
		).toThrow(
			'a case\'s scenario cannot be changed in review (from "s1" to "s2"); run `llm-tests-forge move --case s1-01 --to s2` (id: s1-01)',
		);
	});

	test("an edit may rename a case to a free id, but never onto an id a sibling in its file holds", () => {
		const siblings = new Set(["s1-01", "s1-02"]);
		expect(
			applyDecision(
				makeCase("s1-01", "s1", "pending"),
				"edit",
				{ ...makeCase("s1-01", "s1", "pending"), input: { email: "new" } },
				siblings,
			).id,
		).toBe("s1-01");
		expect(
			applyDecision(
				makeCase("s1-01", "s1", "pending"),
				"edit",
				{ ...makeCase("s1-01", "s1", "pending"), id: "s1-09" },
				siblings,
			).id,
		).toBe("s1-09");
		expect(() =>
			applyDecision(
				makeCase("s1-01", "s1", "pending"),
				"edit",
				{ ...makeCase("s1-01", "s1", "pending"), id: "s1-02" },
				siblings,
			),
		).toThrow(
			'id "s1-02" is already used by another item in the same file; pick an id nothing else uses (id: s1-01)',
		);
	});

	test("edit also validates an edited scenario via the scenario schema", () => {
		const out = applyDecision(makeScenario("s", "pending"), "edit", {
			...makeScenario("s", "pending"),
			description: "changed",
		});
		expect(out.description).toBe("changed");
		expect(out.status).toBe("edited");

		const invalidEdit = JSON.parse(
			JSON.stringify({ ...makeScenario("s", "pending"), kind: "weird" }),
		);
		let caught: unknown;
		try {
			applyDecision(makeScenario("s", "pending"), "edit", invalidEdit);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("kind");
	});

	test("edit refuses to change a scenario's id, which is the name of its cases file", () => {
		let caught: unknown;
		try {
			applyDecision(makeScenario("s", "pending"), "edit", {
				...makeScenario("s", "pending"),
				id: "renamed",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			`a scenario's id cannot be changed in review (from "s" to "renamed"): it names .forge/cases/<id>.yaml; run \`llm-tests-forge move --scenario s renamed\` (id: s)`,
		);

		// Even when the new id is one a sibling already holds: the collision
		// rule would answer "pick an id nothing else uses", and no id would
		// do, because a scenario's id cannot be changed at all.
		let taken: unknown;
		try {
			applyDecision(
				makeScenario("s", "pending"),
				"edit",
				{ ...makeScenario("s", "pending"), id: "sibling" },
				new Set(["s", "sibling"]),
			);
		} catch (error) {
			taken = error;
		}
		expect((taken as ForgeError).message).toBe(
			`a scenario's id cannot be changed in review (from "s" to "sibling"): it names .forge/cases/<id>.yaml; run \`llm-tests-forge move --scenario s sibling\` (id: s)`,
		);

		// The rule is about the id alone: every other field of a scenario is
		// still editable, and a case may still be renamed.
		expect(
			applyDecision(makeScenario("s", "pending"), "edit", {
				...makeScenario("s", "pending"),
				description: "changed",
			}).id,
		).toBe("s");
		expect(
			applyDecision(makeCase("c", "s", "pending"), "edit", {
				...makeCase("c", "s", "pending"),
				id: "renamed",
			}).id,
		).toBe("renamed");
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
		let caught: unknown;
		try {
			applyDecision(feature, "edit", invalidEdit);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
	});

	test("an unrecognized decision throws instead of silently returning undefined", () => {
		// `Decision` has no zod schema behind it, so a caller holding an
		// unvalidated string (e.g. via `any`, the way `runReviewLoop` would
		// receive one from a buggy injected `ask`) can reach applyDecision
		// with a value outside the four literals. JSON round-tripping
		// produces that genuinely-unknown value without an `as any`/`as
		// never` cast.
		const bogus = JSON.parse(JSON.stringify("bogus"));
		let caught: unknown;
		try {
			applyDecision(makeScenario("s", "pending"), bogus);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			'unrecognized decision "bogus" (id: s)',
		);
	});
});

describe("withExpected", () => {
	test("sets a valid expected and rejects an invalid one", () => {
		expect(
			withExpected(makeCase("c", "s", "pending"), { rubric: "r" }).expected,
		).toEqual({
			rubric: "r",
		});

		let caught: unknown;
		try {
			withExpected(makeCase("c", "s", "pending"), {});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			"expected is invalid: expected must carry exactly one of label, fields, rubric (id: c)",
		);
	});

	test("an expected with several problems lists each one", () => {
		const invalid = JSON.parse(JSON.stringify({ label: 3, rubric: 4 }));
		expect(() => withExpected(makeCase("c", "s", "pending"), invalid)).toThrow(
			"expected is invalid: Invalid input: expected string, received number; Invalid input: expected string, received number (id: c)",
		);
	});
});
