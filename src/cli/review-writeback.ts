import { expectedMatchesOracle } from "../core/oracle";
import type { Case, Feature, Oracle } from "../core/schemas";

/**
 * Takes the decision recorded under `key` out of `decided`, so it can be
 * applied to at most one entry.
 *
 * One decision belongs to one item. `Map.get` alone applied it to every
 * entry sharing that key AND handed each the same object reference, so a
 * file with two entries under one id came back with the second replaced by
 * a YAML alias of the first -- its input, its expected and its own review
 * gone, reported as "1 approved". Removing the entry on first hit makes "at
 * most one" structural: the second entry finds nothing and keeps itself.
 */
export function takeOnce<Key, Value>(
	decided: Map<Key, Value>,
	key: Key,
): Value | undefined {
	const hit = decided.get(key);
	if (hit !== undefined) decided.delete(key);
	return hit;
}

export interface ApplyReviewDecisionsArgs {
	/** One cases file, exactly as it was read off disk. */
	list: Case[];
	/**
	 * The pass's case decisions, keyed by the very entry of a read list the
	 * pass offered — the object, not its id. Keyed by id, a decision on a
	 * pending entry landed on the first entry under that id, which could be
	 * an approved twin: its input and review were overwritten, the offered
	 * entry stayed pending, and the summary counted it as decided. The
	 * entry object is its position in the file, so the decision lands on
	 * exactly what the person was shown. Drained as it is applied (see
	 * `takeOnce`).
	 */
	decidedCases: Map<Case, Case>;
	/**
	 * The oracle this pass gave the file's scenario, when it changed one.
	 * `from` is not read here — it belongs to the line the caller prints.
	 */
	oracleChange?: { from: Oracle; to: Oracle };
	/** The feature as this pass left it: `expected` is checked against it. */
	feature: Feature;
}

export interface ReviewWriteback {
	/** The file as it should be written, decisions and re-opens applied. */
	next: Case[];
	reopened: number;
	/**
	 * Whether anything actually changed. An oracle change whose cases all
	 * still fit leaves the file exactly as it was read, and a file no
	 * decision touched is not rewritten.
	 */
	touched: boolean;
	/**
	 * Old id to new id, for every entry of this list a decision renamed.
	 * Built here, where the decision lands, rather than by the caller from
	 * the pass's decisions: `duplicate_of` names a case in the same file,
	 * case ids are scenario-prefixed by convention rather than by rule, and
	 * a map keyed only by id let a rename applied in one file rewrite a
	 * pointer in another that merely spelled the same string.
	 */
	renamed: Map<string, string>;
}

/**
 * One cases file's write-back, with no I/O of its own: the decisions this
 * pass took, the renames it made, and the oracle it may have changed,
 * folded into the list that was read off disk.
 *
 * Every decision is matched back to the entry the pass offered, never by
 * the id it carries now: an edit is allowed to change the id, and matching
 * on the new one found nothing, wrote nothing, and still reported the edit
 * as applied. The list is rebuilt from what was read off disk, so a
 * decision that matched nothing cannot invent an entry to land in.
 *
 * A scenario's oracle is the contract its cases' `expected` was written
 * against, so changing it in review invalidates them wholesale. Nothing
 * used to notice until each case came up again — and `selectCases` refuses
 * the pair, so `estimate`, `emit` and `report` all stopped on a scenario
 * nobody had touched. The cases go back to `pending` with their `expected`
 * kept: it is the reviewer's own answer, and only they can say what it
 * becomes under the new oracle.
 */
export function applyReviewDecisions(
	writebackArguments: ApplyReviewDecisionsArgs,
): ReviewWriteback {
	const { list, decidedCases, oracleChange, feature } = writebackArguments;
	// Read before the decisions are drained out of the map below: after
	// that, "this file had a decision" is no longer a question the map can
	// answer.
	const decided = list.some((caseEntry) => decidedCases.has(caseEntry));
	const renamed = new Map<string, string>();
	const applied = list.map((caseEntry) => {
		const hit = takeOnce(decidedCases, caseEntry);
		if (hit !== undefined && hit.id !== caseEntry.id)
			renamed.set(caseEntry.id, hit.id);
		return hit ?? caseEntry;
	});
	// An edit may rename a case, and `duplicate_of` is the only field that
	// names another case by id. Left behind, the pointer dangles: no data
	// is lost, but `pendingItems` stops placing the pair together and
	// `dedupe`'s own answer reads as being about a case that is not there.
	// Rewritten after every decision landed and in the same write as the
	// rename, so a decided entry's own pointer follows a rename decided
	// later in the list and the file is never briefly inconsistent on disk.
	const followRename = (caseEntry: Case): Case => {
		const target =
			caseEntry.duplicate_of === undefined
				? undefined
				: renamed.get(caseEntry.duplicate_of);
		return target === undefined
			? caseEntry
			: { ...caseEntry, duplicate_of: target };
	};
	let next = applied.map(followRename);

	let reopened = 0;
	if (oracleChange !== undefined) {
		next = next.map((caseEntry) => {
			if (caseEntry.status !== "approved" && caseEntry.status !== "edited")
				return caseEntry;
			if (
				caseEntry.expected !== undefined &&
				expectedMatchesOracle(caseEntry.expected, oracleChange.to, feature) ===
					null
			)
				return caseEntry;
			reopened += 1;
			return { ...caseEntry, status: "pending" };
		});
	}
	return { next, reopened, touched: decided || reopened > 0, renamed };
}
