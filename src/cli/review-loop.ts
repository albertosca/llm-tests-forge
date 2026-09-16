import { parse, stringify } from "yaml";
import { ForgeError } from "../core/errors";
import {
	applyDecision,
	type Decision,
	type PendingItem,
	withExpected,
} from "../core/review";
import type {
	Case,
	Expected,
	Feature,
	Oracle,
	Scenario,
} from "../core/schemas";

export interface ReviewLoopArgs {
	items: PendingItem[];
	ask: (question: string, choices: string[]) => Promise<string>;
	openEditor: (yamlText: string) => Promise<string>;
	askExpected: (c: Case, oracle: Oracle) => Promise<Expected>;
	/**
	 * The oracle contract, applied to a case's `expected` however it got
	 * there: typed at the prompt, typed into `$EDITOR`, or already on disk.
	 * Returns `null` when the value is acceptable, or a sentence naming
	 * what is wrong with it.
	 */
	checkExpected: (c: Case, oracle: Oracle) => string | null;
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
	oracleOf: (c: Case) => Oracle;
	/**
	 * Called once per decision, as it is taken, with the item as decided
	 * and the id it had on disk when the pass started. The pass reads the
	 * feature and the scenario list through `checkExpected`, `askExpected`
	 * and `oracleOf`; without this the caller could only hand them over as
	 * a snapshot, so a label added by editing the feature was still absent
	 * when a case using it came up two items later, and approving it was
	 * refused. `originalId` is passed because an edit may rename the item,
	 * and matching the new id against the pre-pass list finds nothing.
	 */
	onDecided?: (
		kind: PendingItem["kind"],
		item: Feature | Scenario | Case,
		originalId: string,
	) => void;
	print: (line: string) => void;
}

export interface ReviewLoopResult {
	decisions: {
		kind: PendingItem["kind"];
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
		item: Feature | Scenario | Case;
	}[];
	summary: {
		approved: number;
		rejected: number;
		edited: number;
		skipped: number;
	};
}

const CHOICES: Decision[] = ["approve", "reject", "edit", "skip"];

function isDecision(x: string): x is Decision {
	return x === "approve" || x === "reject" || x === "edit" || x === "skip";
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
	args: ReviewLoopArgs,
): Promise<ReviewLoopResult> {
	const decisions: ReviewLoopResult["decisions"] = [];
	const summary = { approved: 0, rejected: 0, edited: 0, skipped: 0 };

	/** The one place a decision is recorded, so `onDecided` cannot be
	 * wired to some of the branches and not the others. */
	const record = (
		kind: PendingItem["kind"],
		originalId: string,
		item: Feature | Scenario | Case,
	): void => {
		decisions.push({ kind, originalId, id: item.id, item });
		args.onDecided?.(kind, item, originalId);
	};

	/**
	 * Nothing leaves this loop approved or edited carrying an expected
	 * value the scenario's oracle does not accept — the prompt checks what
	 * it asks for, but `$EDITOR` and the file on disk are two other ways
	 * the same value arrives. A rejected case is not checked: rejecting a
	 * case with a bad expected is how you get rid of it.
	 */
	const refuseExpectedOutsideOracle = (
		kind: PendingItem["kind"],
		item: Feature | Scenario | Case,
	): void => {
		if (kind !== "case") return;
		const c = item as Case;
		if (c.expected === undefined) return;
		const problem = args.checkExpected(c, args.oracleOf(c));
		if (problem !== null)
			throw new ForgeError(`expected does not match the oracle: ${problem}`, {
				id: c.id,
			});
	};

	for (const pending of args.items) {
		let current: Feature | Scenario | Case = pending.item;
		for (;;) {
			args.print(`--- ${pending.kind} ${current.id} ---`);
			args.print(stringify(current, { lineWidth: 0 }).trimEnd());
			const raw = await args.ask(`${pending.kind} ${current.id}:`, CHOICES);
			if (!isDecision(raw)) {
				throw new ForgeError(
					`ask() returned an answer outside its own choices: "${raw}" (expected one of: ${CHOICES.join(", ")})`,
					{ id: current.id },
				);
			}
			const answer = raw;

			try {
				if (
					pending.kind === "case" &&
					(answer === "approve" || answer === "edit") &&
					(current as Case).expected === undefined
				) {
					const oracle = args.oracleOf(current as Case);
					const expected = await args.askExpected(current as Case, oracle);
					current = withExpected(current as Case, expected);
				}

				if (answer === "edit") {
					const editedText = await args.openEditor(
						stringify(current, { lineWidth: 0 }),
					);
					// `current` is only replaced once the new value has passed
					// every check: a refused decision left it holding a status
					// the file does not have, which the retry then printed and
					// $EDITOR opened on.
					const edited = applyDecision(
						current,
						"edit",
						parse(editedText),
						args.takenIdsFor(pending),
					);
					refuseExpectedOutsideOracle(pending.kind, edited);
					current = edited;
					summary.edited += 1;
					record(pending.kind, pending.item.id, current);
					break;
				}

				if (answer === "skip") {
					summary.skipped += 1;
					break;
				}

				const decided = applyDecision(current, answer);
				if (answer === "approve")
					refuseExpectedOutsideOracle(pending.kind, decided);
				current = decided;
				summary[answer === "approve" ? "approved" : "rejected"] += 1;
				record(pending.kind, pending.item.id, current);
				break;
			} catch (e) {
				if (e instanceof ForgeError) {
					args.print(`cannot apply: ${e.message}`);
					continue;
				}
				throw e;
			}
		}
	}

	return { decisions, summary };
}
