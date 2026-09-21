import { expectedMatchesOracle } from "../core/oracle";
import type { Case, Feature, Oracle } from "../core/schemas";

/**
 * Takes the decision recorded under `id` out of `decided`, so it can be
 * applied to at most one entry.
 *
 * One decision belongs to one item. `Map.get` alone applied it to every
 * entry sharing that id AND handed each the same object reference, so a
 * file with two entries under one id came back with the second replaced by
 * a YAML alias of the first -- its input, its expected and its own review
 * gone, reported as "1 approved". Removing the entry on first hit makes "at
 * most one" structural: the second entry finds nothing and keeps itself.
 * (Carrying an array index instead would mean threading the file position
 * through `PendingItem` and the loop, which reorders cases; this keeps the
 * guarantee where the write happens.)
 */
export function takeOnce<T>(
	decided: Map<string, T>,
	id: string,
): T | undefined {
	const hit = decided.get(id);
	if (hit !== undefined) decided.delete(id);
	return hit;
}

export interface ApplyReviewDecisionsArgs {
	/** One cases file, exactly as it was read off disk. */
	list: Case[];
	/**
	 * The pass's case decisions, keyed by the id each item had on entry.
	 * Drained as it is applied (see `takeOnce`), which is also what keeps
	 * one decision from being handed to two files: the caller passes the
	 * same map for every file it walks.
	 */
	decidedCases: Map<string, Case>;
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
 * Every decision is matched back to the file by the id the item had when
 * the pass started, never by the id it carries now: an edit is allowed to
 * change the id, and matching on the new one found nothing, wrote nothing,
 * and still reported the edit as applied. The list is rebuilt from what was
 * read off disk, so a decision that matched nothing cannot invent an entry
 * to land in.
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
	args: ApplyReviewDecisionsArgs,
): ReviewWriteback {
	const { list, decidedCases, oracleChange, feature } = args;
	// Read before the decisions are drained out of the map below: after
	// that, "this file had a decision" is no longer a question the map can
	// answer.
	const decided = list.some((c) => decidedCases.has(c.id));
	const renamed = new Map<string, string>();
	const applied = list.map((c) => {
		const decided = takeOnce(decidedCases, c.id);
		if (decided !== undefined && decided.id !== c.id)
			renamed.set(c.id, decided.id);
		return decided ?? c;
	});
	// An edit may rename a case, and `duplicate_of` is the only field that
	// names another case by id. Left behind, the pointer dangles: no data
	// is lost, but `pendingItems` stops placing the pair together and
	// `dedupe`'s own answer reads as being about a case that is not there.
	// Rewritten after every decision landed and in the same write as the
	// rename, so a decided entry's own pointer follows a rename decided
	// later in the list and the file is never briefly inconsistent on disk.
	const followRename = (c: Case): Case => {
		const to =
			c.duplicate_of === undefined ? undefined : renamed.get(c.duplicate_of);
		return to === undefined ? c : { ...c, duplicate_of: to };
	};
	let next = applied.map(followRename);

	let reopened = 0;
	if (oracleChange !== undefined) {
		next = next.map((c) => {
			if (c.status !== "approved" && c.status !== "edited") return c;
			if (
				c.expected !== undefined &&
				expectedMatchesOracle(c.expected, oracleChange.to, feature) === null
			)
				return c;
			reopened += 1;
			return { ...c, status: "pending" };
		});
	}
	return { next, reopened, touched: decided || reopened > 0, renamed };
}
