import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import { moveCase, renameScenario } from "../../src/core/move";
import type {
	Case,
	Feature,
	Oracle,
	Scenario,
	Suite,
} from "../../src/core/schemas";

const feature: Feature = {
	id: "f",
	purpose: "p",
	inputs: [{ name: "email", kind: "text" }],
	output: { kind: "label", labels: ["a", "b"] },
	invariants: [],
	status: "approved",
};

const scn = (
	id: string,
	oracle: Oracle = "label",
	status: Scenario["status"] = "approved",
): Scenario => ({ id, kind: "happy", oracle, description: `d ${id}`, status });

const cs = (id: string, scenario: string, extra: Partial<Case> = {}): Case => ({
	id,
	scenario,
	input: { email: id },
	expected: { label: "a" },
	status: "approved",
	generated_by: "t",
	...extra,
});

const suiteWith = (include: string[]): Suite => ({
	target: {
		kind: "promptfoo-python",
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5"],
	},
	judges: ["google/gemini-3.5-flash"],
	repeat: 1,
	include,
});

const thrown = (run: () => unknown): ForgeError => {
	let err: unknown;
	try {
		run();
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(ForgeError);
	return err as ForgeError;
};

describe("renameScenario", () => {
	test("renames the scenario, renumbers every case of it, and follows duplicate_of", () => {
		const result = renameScenario({
			from: "old",
			to: "new",
			scenarios: [scn("old", "rubric", "edited"), scn("keep")],
			cases: [
				cs("old-01", "old"),
				cs("old-02", "old", { duplicate_of: "old-01", status: "pending" }),
			],
			suite: null,
		});

		// The scenario keeps everything but its id: an id is the name of a
		// file, and a rename is not a review decision about the scenario.
		expect(result.scenarios).toEqual([
			{
				id: "new",
				kind: "happy",
				oracle: "rubric",
				description: "d old",
				status: "edited",
			},
			scn("keep"),
		]);
		expect(result.cases.map((c) => [c.id, c.scenario, c.status])).toEqual([
			["new-01", "new", "approved"],
			["new-02", "new", "pending"],
		]);
		// The pointer follows the rename in the same object it is written
		// from: a dangling `duplicate_of` is how `pendingItems` stops
		// placing a duplicate next to what it duplicates.
		expect(result.cases[1]?.duplicate_of).toBe("new-01");
		expect([...result.renamedIds]).toEqual([
			["old-01", "new-01"],
			["old-02", "new-02"],
		]);
	});

	test("an unknown `from` is refused by name and nothing is rewritten", () => {
		const err = thrown(() =>
			renameScenario({
				from: "ghost",
				to: "new",
				scenarios: [scn("old")],
				cases: [],
				suite: null,
			}),
		);
		expect(err.message).toBe(
			'scenario "ghost" is not in scenarios.yaml (id: ghost)',
		);
	});

	test("a `to` another scenario already holds is refused by name", () => {
		const err = thrown(() =>
			renameScenario({
				from: "old",
				to: "taken",
				scenarios: [scn("old"), scn("taken")],
				cases: [],
				suite: null,
			}),
		);
		expect(err.message).toBe(
			'scenario "taken" already exists in scenarios.yaml; pick an id nothing else uses (id: taken)',
		);
	});

	test("renaming a scenario onto its own id is refused as a taken id", () => {
		const err = thrown(() =>
			renameScenario({
				from: "old",
				to: "old",
				scenarios: [scn("old")],
				cases: [],
				suite: null,
			}),
		);
		expect(err.message).toBe(
			'scenario "old" already exists in scenarios.yaml; pick an id nothing else uses (id: old)',
		);
	});

	test("suite.include names the scenario by id, so the entry moves with it", () => {
		const result = renameScenario({
			from: "old",
			to: "new",
			scenarios: [scn("old"), scn("keep")],
			cases: [],
			suite: suiteWith(["keep", "old"]),
		});
		expect(result.suite?.include).toEqual(["keep", "new"]);
		// Everything else of the suite is carried over untouched.
		expect(result.suite?.judges).toEqual(["google/gemini-3.5-flash"]);
	});

	test("a suite of null stays null rather than being invented", () => {
		const result = renameScenario({
			from: "old",
			to: "new",
			scenarios: [scn("old")],
			cases: [],
			suite: null,
		});
		expect(result.suite).toBeNull();
	});

	test("a case whose id does not carry the scenario's prefix keeps it, and still moves", () => {
		const result = renameScenario({
			from: "old",
			to: "new",
			scenarios: [scn("old")],
			cases: [cs("hand-written", "old")],
			suite: null,
		});
		expect(result.cases.map((c) => [c.id, c.scenario])).toEqual([
			["hand-written", "new"],
		]);
		// Nothing was renumbered, so nothing is reported as renumbered.
		expect([...result.renamedIds]).toEqual([]);
	});

	test("a case in the file that names another scenario is left exactly as it was", () => {
		const foreign = cs("old-02", "elsewhere");
		const result = renameScenario({
			from: "old",
			to: "new",
			scenarios: [scn("old"), scn("elsewhere")],
			cases: [cs("old-01", "old"), foreign],
			suite: null,
		});
		// A hand edit put it there and a rename is not the verb that fixes
		// it: rewriting its `scenario` here would throw away the only
		// record of where it was meant to go.
		expect(result.cases[1]).toEqual(foreign);
		expect(result.cases[0]?.id).toBe("new-01");
	});
});

describe("moveCase", () => {
	const from = scn("old");
	const to = scn("dest");

	test("moves the case into the destination's numbering and out of the source file", () => {
		const result = moveCase({
			caseId: "old-02",
			from,
			to,
			fromCases: [cs("old-01", "old"), cs("old-02", "old")],
			toCases: [cs("dest-01", "dest"), cs("dest-02", "dest")],
			feature,
		});
		expect(result.moved.id).toBe("dest-03");
		expect(result.moved.scenario).toBe("dest");
		// The expected fits the destination's oracle, so the review it
		// already had stands.
		expect(result.moved.status).toBe("approved");
		expect(result.reopened).toBeNull();
		expect(result.fromCases.map((c) => c.id)).toEqual(["old-01"]);
		expect(result.toCases.map((c) => c.id)).toEqual([
			"dest-01",
			"dest-02",
			"dest-03",
		]);
		// The input travels with the case; only what names a file changes.
		expect(result.moved.input).toEqual({ email: "old-02" });
	});

	test("an expected the destination's oracle does not accept re-opens the case and says why", () => {
		const result = moveCase({
			caseId: "old-01",
			from,
			to: scn("dest", "rubric"),
			fromCases: [cs("old-01", "old")],
			toCases: [],
			feature,
		});
		expect(result.moved.status).toBe("pending");
		expect(result.reopened).toBe(
			"oracle is rubric but expected.rubric is missing",
		);
		// The expected is kept as the reviewer wrote it: only they can say
		// what it becomes under the new oracle.
		expect(result.moved.expected).toEqual({ label: "a" });
		expect(result.moved.id).toBe("dest-01");
	});

	test("a case with no expected at all has nothing to re-check, and keeps its status", () => {
		const imported = cs("old-01", "old", {
			expected: undefined,
			status: "pending",
		});
		const result = moveCase({
			caseId: "old-01",
			from,
			to: scn("dest", "rubric"),
			fromCases: [imported],
			toCases: [],
			feature,
		});
		expect(result.reopened).toBeNull();
		expect(result.moved.status).toBe("pending");
		expect(result.moved.expected).toBeUndefined();
	});

	test("the moved case drops its own duplicate_of, and the siblings pointing at it lose theirs", () => {
		const result = moveCase({
			caseId: "old-02",
			from,
			to,
			fromCases: [
				cs("old-01", "old"),
				cs("old-02", "old", { duplicate_of: "old-01" }),
				cs("old-03", "old", { duplicate_of: "old-02" }),
			],
			toCases: [],
			feature,
		});
		// `duplicate_of` names a case in the same file, and neither end of
		// the pair is in the same file as the other any more.
		expect("duplicate_of" in result.moved).toBe(false);
		expect(result.fromCases.map((c) => [c.id, c.duplicate_of])).toEqual([
			["old-01", undefined],
			["old-03", undefined],
		]);
		expect("duplicate_of" in (result.fromCases[1] ?? {})).toBe(false);
	});

	test("a case the source file does not hold is refused by name", () => {
		const err = thrown(() =>
			moveCase({
				caseId: "old-09",
				from,
				to,
				fromCases: [cs("old-01", "old")],
				toCases: [],
				feature,
			}),
		);
		expect(err.message).toBe(
			'case "old-09" is not in scenario "old" (id: old-09)',
		);
	});

	test("moving a case into the scenario it is already in is refused, not renumbered", () => {
		// The source and the destination are the same file: writing the
		// destination and then removing the source would delete the file
		// that was just written.
		const err = thrown(() =>
			moveCase({
				caseId: "old-01",
				from,
				to: scn("old"),
				fromCases: [cs("old-01", "old")],
				toCases: [cs("old-01", "old")],
				feature,
			}),
		);
		expect(err.message).toBe(
			'case "old-01" is already in scenario "old" (id: old-01)',
		);
	});
});
