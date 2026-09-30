import { parse, stringify } from "yaml";
import { ForgeError } from "../core/errors";
import {
	applyDecision,
	type Decision,
	type PendingItem,
	pendingItemFor,
	withExpected,
} from "../core/review";
import type {
	Case,
	Expected,
	Feature,
	Oracle,
	Scenario,
} from "../core/schemas";
import { palette, renderItem } from "./colors";

export interface ReviewLoopArgs {
	items: PendingItem[];
	ask: (question: string, choices: string[]) => Promise<string>;
	openEditor: (yamlText: string) => Promise<string>;
	askExpected: (caseEntry: Case, oracle: Oracle) => Promise<Expected>;
	/**
	 * The oracle contract, applied to a case's `expected` however it got
	 * there: typed at the prompt, typed into `$EDITOR`, or already on disk.
	 * Returns `null` when the value is acceptable, or a sentence naming
	 * what is wrong with it.
	 */
	checkExpected: (caseEntry: Case, oracle: Oracle) => string | null;
	/**
	 * Every id already present in the file this item lives in, so an edit
	 * cannot rename it onto one of its siblings.
	 */
	takenIdsFor: (item: PendingItem) => ReadonlySet<string>;
	/**
	 * The oracle a case answers to. Takes the case rather than its
	 * scenario id so the caller can name the case when the scenario it
	 * points at does not exist — that is a broken file, and answering it
	 * with a default oracle asked the person the wrong question instead.
	 */
	oracleOf: (caseEntry: Case) => Oracle;
	/**
	 * Called once per decision, as it is taken, with the item as decided
	 * and the id it had on disk when the pass started. The pass reads the
	 * feature and the scenario list through `checkExpected`, `askExpected`
	 * and `oracleOf`; without this the caller could only hand them over as
	 * a snapshot, so a label added by editing the feature was still absent
	 * when a case using it came up two items later, and approving it was
	 * refused. `originalId` is passed because an edit may rename the item,
	 * and matching the new id against the pre-pass list finds nothing.
	 *
	 * `decided` is the kind and the item already paired, so narrowing on
	 * `decided.kind` types `decided.item` too: the kind and a bare item as
	 * two arguments left every caller casting them back together.
	 */
	onDecided?: (decided: PendingItem, originalId: string) => void;
	print: (line: string) => void;
	/**
	 * How an item is shown before its question. Defaults to the plain header
	 * and YAML; the CLI passes the colored rendering when the output is an
	 * interactive terminal (see `src/cli/colors.ts`).
	 */
	render?: (item: PendingItem) => string;
}

/** The two ids every recorded decision carries, whatever kind it is. */
interface DecisionIds {
	/**
	 * The id the item had on disk when this pass started, before any
	 * edit. Ids are model-generated slugs a person reads in `$EDITOR`,
	 * so fixing one is a likely edit — and the caller writes a decision
	 * back by matching it against the file, which only works with the
	 * pre-edit id. Matching on the post-edit `id` silently matched
	 * nothing and reported the edit as written.
	 */
	originalId: string;
	id: string;
}

export interface ReviewLoopResult {
	/**
	 * The kind and the item paired the way `PendingItem` pairs them, plus
	 * the two ids. A `kind` beside a bare `Feature | Scenario | Case` made
	 * the caller that writes each kind back to its own file cast the two
	 * together again; narrowing on `kind` now types `item` as well.
	 */
	decisions: (PendingItem & DecisionIds)[];
	summary: {
		approved: number;
		rejected: number;
		edited: number;
		skipped: number;
	};
}

const CHOICES: Decision[] = ["approve", "reject", "edit", "skip"];

function isDecision(answer: string): answer is Decision {
	return (
		answer === "approve" ||
		answer === "reject" ||
		answer === "edit" ||
		answer === "skip"
	);
}

/**
 * Drives one interactive pass over `items`. Every side effect — prompting,
 * opening an editor, asking for an expected outcome, printing — arrives as
 * an injected function, so this function performs no I/O itself and is
 * fully exercised by scripting those functions in tests.
 *
 * A case with no `expected` is sent through `askExpected` before it can be
 * approved or edited. An invalid edit (one that fails the matching schema)
 * is reported and the same item is re-asked, rather than moving on. `skip`
 * produces no decision at all — the caller writes back only what is
 * decided, and a skipped item must not be rewritten.
 *
 * `ask` is contractually bound to answer with one of the `choices` it was
 * given, but that contract is not enforced by any schema — an injected
 * implementation that violates it (a bug in `ask` itself, not a mistake by
 * the human answering it) raises a named `ForgeError` that propagates out
 * of this function, rather than being retried like a bad edit would be.
 */
export async function runReviewLoop(
	loopArguments: ReviewLoopArgs,
): Promise<ReviewLoopResult> {
	const render =
		loopArguments.render ?? ((item) => renderItem(item, palette(false)));
	const decisions: ReviewLoopResult["decisions"] = [];
	const summary = { approved: 0, rejected: 0, edited: 0, skipped: 0 };

	/** The one place a decision is recorded, so `onDecided` cannot be
	 * wired to some of the branches and not the others. The kind is read
	 * off the decided item once, here, and both the recorded decision and
	 * the callback are given that one answer. */
	const record = (
		originalId: string,
		item: Feature | Scenario | Case,
	): void => {
		const decided = pendingItemFor(item);
		decisions.push({ ...decided, originalId, id: item.id });
		loopArguments.onDecided?.(decided, originalId);
	};

	/**
	 * Nothing leaves this loop approved or edited carrying an expected
	 * value the scenario's oracle does not accept — the prompt checks what
	 * it asks for, but `$EDITOR` and the file on disk are two other ways
	 * the same value arrives. A rejected case is not checked: rejecting a
	 * case with a bad expected is how you get rid of it.
	 */
	const refuseExpectedOutsideOracle = (item: PendingItem): void => {
		if (item.kind !== "case") return;
		const caseEntry = item.item;
		if (caseEntry.expected === undefined) return;
		const problem = loopArguments.checkExpected(
			caseEntry,
			loopArguments.oracleOf(caseEntry),
		);
		if (problem !== null)
			throw new ForgeError(`expected does not match the oracle: ${problem}`, {
				id: caseEntry.id,
			});
	};

	for (const pending of loopArguments.items) {
		// The kind and the item stay paired all the way through, so
		// narrowing on `current.kind` types `current.item`; a bare
		// `Feature | Scenario | Case` beside `pending.kind` had every case
		// branch casting the two back together.
		let current: PendingItem = pending;
		for (;;) {
			// Header and body are two prints, as they always were: callers
			// and tests read the header as a line of its own.
			const [header = "", ...body] = render(current).split("\n");
			loopArguments.print(header);
			loopArguments.print(body.join("\n"));
			const raw = await loopArguments.ask(
				`${pending.kind} ${current.item.id}:`,
				CHOICES,
			);
			if (!isDecision(raw)) {
				throw new ForgeError(
					`ask() returned an answer outside its own choices: "${raw}" (expected one of: ${CHOICES.join(", ")})`,
					{ id: current.item.id },
				);
			}
			const answer = raw;

			try {
				if (
					current.kind === "case" &&
					(answer === "approve" || answer === "edit") &&
					current.item.expected === undefined
				) {
					const oracle = loopArguments.oracleOf(current.item);
					const expected = await loopArguments.askExpected(
						current.item,
						oracle,
					);
					current = {
						kind: "case",
						item: withExpected(current.item, expected),
					};
				}

				if (answer === "edit") {
					const editedText = await loopArguments.openEditor(
						stringify(current.item, { lineWidth: 0 }),
					);
					// `current` is only replaced once the new value has passed
					// every check: a refused decision left it holding a status
					// the file does not have, which the retry then printed and
					// $EDITOR opened on.
					const edited = pendingItemFor(
						applyDecision(
							current.item,
							"edit",
							parse(editedText),
							loopArguments.takenIdsFor(pending),
						),
					);
					refuseExpectedOutsideOracle(edited);
					current = edited;
					summary.edited += 1;
					record(pending.item.id, current.item);
					break;
				}

				if (answer === "skip") {
					summary.skipped += 1;
					break;
				}

				const decided = pendingItemFor(applyDecision(current.item, answer));
				if (answer === "approve") refuseExpectedOutsideOracle(decided);
				current = decided;
				summary[answer === "approve" ? "approved" : "rejected"] += 1;
				record(pending.item.id, current.item);
				break;
			} catch (error) {
				if (error instanceof ForgeError) {
					loopArguments.print(`cannot apply: ${error.message}`);
					continue;
				}
				throw error;
			}
		}
	}

	return { decisions, summary };
}
