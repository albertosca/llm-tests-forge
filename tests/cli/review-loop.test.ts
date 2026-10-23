import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { EditorInterruptedError, InputEndedError } from "../../src/cli/prompts";
import type { ReviewLoopResult } from "../../src/cli/review-loop";
import { runReviewLoop } from "../../src/cli/review-loop";
import { ForgeError } from "../../src/core/errors";
import type { PendingItem } from "../../src/core/review";
import type { Case, Expected, Feature, Scenario } from "../../src/core/schemas";

/**
 * Pulls the case out of a decided item at `i`, failing loudly if the loop
 * did not actually record a decision there — avoids `?.` chained straight
 * into a cast, which would silently produce `undefined` at runtime instead
 * of failing the assertion that follows.
 */
function caseAt(result: ReviewLoopResult, index: number): Case {
	const decision = result.decisions[index];
	if (!decision) throw new Error(`expected a decision at index ${index}`);
	return decision.item as Case;
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
		const result = await runReviewLoop({
			items,
			ask: scripted(["approve", "reject"]),
			openEditor: async (yamlText) => yamlText,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});
		expect(result.summary).toEqual({
			approved: 1,
			rejected: 1,
			edited: 0,
			skipped: 0,
		});
		expect(
			result.decisions.map((decision) => [decision.id, decision.item.status]),
		).toEqual([
			["s", "approved"],
			["s-01", "rejected"],
		]);
		expect(printed.join("\n")).toContain("id: s-01");
	});

	test("asks for expected before approving a case that has none", async () => {
		let asked = 0;
		const result = await runReviewLoop({
			items: [{ kind: "case", item: noExp }],
			ask: scripted(["approve"]),
			openEditor: async (yamlText) => yamlText,
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
		expect(caseAt(result, 0).expected).toEqual({
			label: "rejection",
		});
	});

	test("asks for expected before editing a case that has none, and the editor sees it filled in", async () => {
		let asked = 0;
		let editorSawExpected: unknown;
		const result = await runReviewLoop({
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
		expect(result.summary.edited).toBe(1);
		expect(caseAt(result, 0).expected).toEqual({
			label: "rejection",
		});
		expect(caseAt(result, 0).status).toBe("edited");
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
		const result = await runReviewLoop({
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
			print: (line) => printed.push(line),
		});

		// indexOf/lastIndexOf would collapse the two identical item-1 headers
		// to the same position, so collect every matching index by hand.
		const item1Indices = printed
			.map((line, index) =>
				line === `--- case ${withExp.id} ---` ? index : -1,
			)
			.filter((index) => index !== -1);
		const item2Indices = printed
			.map((line, index) =>
				line === `--- scenario ${scn.id} ---` ? index : -1,
			)
			.filter((index) => index !== -1);
		expect(item1Indices.length).toBe(2);
		expect(item2Indices.length).toBe(1);
		expect(Math.max(...item1Indices)).toBeLessThan(Math.min(...item2Indices));

		expect(result.summary).toEqual({
			approved: 1,
			rejected: 0,
			edited: 1,
			skipped: 0,
		});
		expect(caseAt(result, 0).input.email).toBe("edited");
	});

	test("a non-ForgeError raised while applying a decision propagates instead of being retried", async () => {
		await expect(
			runReviewLoop({
				items: [{ kind: "case", item: noExp }],
				ask: scripted(["approve"]),
				openEditor: async (yamlText) => yamlText,
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
		let caught: unknown;
		try {
			await runReviewLoop({
				items: [{ kind: "scenario", item: scn }],
				ask: scripted(["yolo"]),
				openEditor: async (yamlText) => yamlText,
				askExpected: async () => ({ label: "x" }),
				checkExpected: () => null,
				takenIdsFor: () => new Set(),
				oracleOf: () => "label",
				print: () => {},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect(caught).not.toBeInstanceOf(TypeError);
		expect((caught as ForgeError).message).toContain('"yolo"');
		expect((caught as ForgeError).message).toContain(scn.id);
	});

	test("drives a feature item through a failed reject (which re-asks) then an approve", async () => {
		const printed: string[] = [];
		const seen: PendingItem[] = [];
		const result = await runReviewLoop({
			items: [{ kind: "feature", item: feature }],
			ask: scripted(["reject", "approve"]),
			openEditor: async (yamlText) => yamlText,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			onDecided: (decided) => seen.push(decided),
			print: (line) => printed.push(line),
		});
		// The third kind the callback can be handed, paired the same way.
		expect(seen).toEqual([
			{ kind: "feature", item: { ...feature, status: "approved" } },
		]);
		expect(result.summary).toEqual({
			approved: 1,
			rejected: 0,
			edited: 0,
			skipped: 0,
		});
		expect(result.decisions).toEqual([
			{
				kind: "feature",
				originalId: feature.id,
				id: feature.id,
				item: { ...feature, status: "approved" },
				offered: { kind: "feature", item: feature },
			},
		]);
		expect(
			printed.some(
				(line) =>
					line.startsWith("cannot apply:") &&
					line.includes("cannot be rejected"),
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
		const result = await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["edit", "edit"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "a" }),
			checkExpected: (expected) =>
				expected.label === "a"
					? null
					: `label "${expected.label}" is not one of the feature's labels`,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});

		expect(printed).toContain(
			`cannot apply: expected does not match the oracle: label "not-a-label" is not one of the feature's labels (id: ${withExp.id})`,
		);
		expect(result.summary.edited).toBe(1);
		expect(caseAt(result, 0).expected).toEqual({ label: "a" });
	});

	test("an edit renaming an item onto a sibling's id is refused by name and re-asked", async () => {
		// A case, not a scenario: a scenario's id is the name of its cases
		// file and `applyDecision` refuses to change it at all, so only a
		// case can reach the sibling-collision rule by being renamed.
		const edits = [
			stringify({ ...withExp, id: "already-taken" }),
			stringify({ ...withExp, id: "free-id" }),
		];
		const printed: string[] = [];
		const result = await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["edit", "edit"]),
			openEditor: async () => edits.shift() ?? "",
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set([withExp.id, "already-taken"]),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});

		expect(printed).toContain(
			`cannot apply: id "already-taken" is already used by another item in the same file; pick an id nothing else uses (id: ${withExp.id})`,
		);
		expect(
			result.decisions.map((decision) => [decision.originalId, decision.id]),
		).toEqual([[withExp.id, "free-id"]]);
	});

	test("a refused decision leaves the item printed with the status it still has on disk", async () => {
		// The oracle refusal used to fire after `current` had already been
		// reassigned, so the retry printed `status: approved` for an item
		// that was still pending everywhere else.
		const printed: string[] = [];
		await runReviewLoop({
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["approve"]),
			openEditor: async (yamlText) => yamlText,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => 'label "x" is not one of the feature\'s labels',
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});

		expect(printed.filter((line) => line.includes("status: approved"))).toEqual(
			[],
		);
		expect(
			printed.filter((line) => line.includes("status: pending")).length,
		).toBe(2);
	});

	test("reports every decision to onDecided as it is taken, under the id the item had on entry, and reports nothing for a skip", async () => {
		const seen: [PendingItem, string][] = [];
		await runReviewLoop({
			items: [
				{ kind: "case", item: withExp },
				{ kind: "scenario", item: scn },
				{ kind: "case", item: noExp },
			],
			ask: scripted(["edit", "approve", "skip"]),
			openEditor: async () => stringify({ ...withExp, id: "s-42" }),
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			onDecided: (decided, originalId) => seen.push([decided, originalId]),
			print: () => {},
		});
		// The renamed case is reported under "s-01", the id the caller can
		// still find in the file it read; the skipped case is not reported.
		expect(
			seen.map(([decided, originalId]) => [
				decided.kind,
				decided.item.id,
				originalId,
			]),
		).toEqual([
			["case", "s-42", withExp.id],
			["scenario", scn.id, scn.id],
		]);
		// The argument is the kind and the item already paired: a caller
		// narrowing on `decided.kind` gets the item's type from the same
		// check, rather than casting a bare item back into shape.
		expect(seen[1]?.[0]).toEqual({
			kind: "scenario",
			item: { ...scn, status: "approved" },
		});
		expect(seen[0]?.[0]).toEqual({
			kind: "case",
			item: { ...withExp, id: "s-42", status: "edited" },
		});
	});

	test("an editor killed by Ctrl+C skips the item on screen and every later one, as a Ctrl+C at the prompt does: no retry, no re-render, nothing after it asked", async () => {
		// A ForgeError from the editor used to read as a bad edit: "cannot
		// apply" was printed, the same item was rendered and asked again,
		// and the person who pressed Ctrl+C to stop was asked to go on.
		const printed: string[] = [];
		const answers = ["approve", "edit"];
		let asked = 0;
		const result = await runReviewLoop({
			items: [
				{ kind: "feature", item: feature },
				{ kind: "case", item: withExp },
				{ kind: "scenario", item: scn },
			],
			ask: async () => {
				asked += 1;
				return answers.shift() ?? "approve";
			},
			openEditor: async () => {
				throw new EditorInterruptedError('editor "vi" was interrupted');
			},
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});
		expect(result.summary).toEqual({
			approved: 1,
			rejected: 0,
			edited: 0,
			skipped: 2,
		});
		expect(result.decisions.map((decision) => decision.kind)).toEqual([
			"feature",
		]);
		expect(
			printed.filter((line) => line === `--- case ${withExp.id} ---`),
		).toHaveLength(1);
		expect(
			printed.filter((line) => line === `--- scenario ${scn.id} ---`),
		).toHaveLength(0);
		expect(printed.some((line) => line.startsWith("cannot apply:"))).toBe(
			false,
		);
		expect(asked).toBe(2);
	});

	test("the input ending while an expected value is asked for skips the item on screen and every later one: no 'cannot apply', no re-render", async () => {
		const printed: string[] = [];
		const result = await runReviewLoop({
			items: [
				{ kind: "case", item: noExp },
				{ kind: "scenario", item: scn },
			],
			ask: scripted(["approve", "approve"]),
			openEditor: async (yamlText) => yamlText,
			askExpected: async (caseEntry) => {
				throw new InputEndedError("the input ended", { id: caseEntry.id });
			},
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: (line) => printed.push(line),
		});
		expect(result.summary).toEqual({
			approved: 0,
			rejected: 0,
			edited: 0,
			skipped: 2,
		});
		expect(result.decisions).toEqual([]);
		expect(
			printed.filter((line) => line === `--- case ${noExp.id} ---`),
		).toHaveLength(1);
		expect(
			printed.filter((line) => line === `--- scenario ${scn.id} ---`),
		).toHaveLength(0);
		expect(printed.some((line) => line.startsWith("cannot apply:"))).toBe(
			false,
		);
	});

	test("skip leaves no decision", async () => {
		const result = await runReviewLoop({
			items: [{ kind: "scenario", item: scn }],
			ask: scripted(["skip"]),
			openEditor: async (yamlText) => yamlText,
			askExpected: async () => ({ label: "x" }),
			checkExpected: () => null,
			takenIdsFor: () => new Set(),
			oracleOf: () => "label",
			print: () => {},
		});
		expect(result.decisions).toEqual([]);
		expect(result.summary.skipped).toBe(1);
	});
});

describe("runReviewLoop: what a person reads and what the editor receives", () => {
	const base = {
		openEditor: async (yamlText: string) => yamlText,
		askExpected: async () => ({ label: "x" }),
		checkExpected: () => null,
		takenIdsFor: () => new Set<string>(),
		oracleOf: () => "label" as const,
	};

	test("the question names the kind of the item and its id, and offers the four choices", async () => {
		const asked: [string, string[]][] = [];
		await runReviewLoop({
			...base,
			items: [{ kind: "case", item: withExp }],
			ask: async (question, choices) => {
				asked.push([question, choices]);
				return "skip";
			},
			print: () => {},
		});
		expect(asked).toStrictEqual([
			["case s-01:", ["approve", "reject", "edit", "skip"]],
		]);
	});

	test.each([
		["one line, no newline", "only a header", ["only a header", ""]],
		["a header and one line", "head\nbody", ["head", "body"]],
		["a header and a multi-line body", "head\nb1\nb2\n", ["head", "b1\nb2\n"]],
		["an empty rendering", "", ["", ""]],
		["a newline first", "\nrest", ["", "rest"]],
	])(
		"the header and the body are two prints of their own: %s",
		async (_label, rendering, expected) => {
			const printed: string[] = [];
			await runReviewLoop({
				...base,
				items: [{ kind: "scenario", item: scn }],
				ask: scripted(["skip"]),
				render: () => rendering,
				print: (line) => printed.push(line),
			});
			expect(printed).toStrictEqual(expected);
		},
	);

	test("an answer outside the choices is refused with the answer, the choices in order, and the item's id", async () => {
		let caught: unknown;
		try {
			await runReviewLoop({
				...base,
				items: [{ kind: "scenario", item: scn }],
				ask: scripted(["yolo"]),
				print: () => {},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			'ask() returned an answer outside its own choices: "yolo" (expected one of: approve, reject, edit, skip) (id: s)',
		);
		expect((caught as ForgeError).details).toStrictEqual({ id: "s" });
	});

	test("the editor receives long text on the line it is written on, never folded at 80 columns", async () => {
		const sentence = Array.from({ length: 40 }, () => "word").join(" ");
		const longCase: Case = { ...withExp, input: { email: sentence } };
		let received = "";
		await runReviewLoop({
			...base,
			items: [{ kind: "case", item: longCase }],
			ask: scripted(["edit"]),
			openEditor: async (yamlText) => {
				received = yamlText;
				return yamlText;
			},
			print: () => {},
		});
		expect(received).toContain(`email: ${sentence}\n`);
	});
});

describe("runReviewLoop: the oracle check", () => {
	const base = {
		openEditor: async (yamlText: string) => yamlText,
		askExpected: async () => ({ label: "x" }),
		takenIdsFor: () => new Set<string>(),
		oracleOf: () => "label" as const,
	};

	test("rejecting a case whose expected the oracle does not accept is allowed: that is how it is got rid of", async () => {
		const printed: string[] = [];
		const checked: Expected[] = [];
		const result = await runReviewLoop({
			...base,
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["reject"]),
			checkExpected: (expected) => {
				checked.push(expected);
				return "label is not one of the feature's labels";
			},
			print: (line) => printed.push(line),
		});
		expect(result.summary.rejected).toBe(1);
		expect(caseAt(result, 0).status).toBe("rejected");
		expect(checked).toStrictEqual([]);
		expect(printed.some((line) => line.startsWith("cannot apply"))).toBe(false);
	});

	test("a case edited down to no expected at all is not checked against the oracle", async () => {
		const { expected: _dropped, ...withoutExpected } = withExp;
		const checked: Expected[] = [];
		const result = await runReviewLoop({
			...base,
			items: [{ kind: "case", item: withExp }],
			ask: scripted(["edit"]),
			openEditor: async () => stringify(withoutExpected),
			checkExpected: (expected) => {
				checked.push(expected);
				return "an expected label is required";
			},
			print: () => {},
		});
		expect(checked).toStrictEqual([]);
		expect(result.summary.edited).toBe(1);
		expect(caseAt(result, 0).expected).toBeUndefined();
	});
});
