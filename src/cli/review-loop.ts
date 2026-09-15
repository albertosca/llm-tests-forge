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
	oracleOf: (scenarioId: string) => Oracle;
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
		const problem = args.checkExpected(c, args.oracleOf(c.scenario));
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
					const oracle = args.oracleOf((current as Case).scenario);
					const expected = await args.askExpected(current as Case, oracle);
					current = withExpected(current as Case, expected);
				}

				if (answer === "edit") {
					const editedText = await args.openEditor(
						stringify(current, { lineWidth: 0 }),
					);
					current = applyDecision(current, "edit", parse(editedText));
					refuseExpectedOutsideOracle(pending.kind, current);
					summary.edited += 1;
					decisions.push({
						kind: pending.kind,
						originalId: pending.item.id,
						id: current.id,
						item: current,
					});
					break;
				}

				if (answer === "skip") {
					summary.skipped += 1;
					break;
				}

				current = applyDecision(current, answer);
				if (answer === "approve")
					refuseExpectedOutsideOracle(pending.kind, current);
				summary[answer === "approve" ? "approved" : "rejected"] += 1;
				decisions.push({
					kind: pending.kind,
					originalId: pending.item.id,
					id: current.id,
					item: current,
				});
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
