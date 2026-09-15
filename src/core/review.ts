import { ForgeError } from "./errors";
import {
	type Case,
	CaseSchema,
	type Expected,
	ExpectedSchema,
	type Feature,
	FeatureSchema,
	type Scenario,
	ScenarioSchema,
} from "./schemas";

export type Decision = "approve" | "reject" | "edit" | "skip";

export type PendingItem =
	| { kind: "feature"; item: Feature }
	| { kind: "scenario"; item: Scenario }
	| { kind: "case"; item: Case };

/**
 * Feature first (if pending), then pending scenarios in file order, then
 * pending cases in file order — except a case carrying `duplicate_of` is
 * moved to sit immediately after the case it points at, when that case is
 * also in the pending list. A case whose `duplicate_of` target is missing
 * from `cases` entirely, or present but not pending, keeps its own
 * file-order position.
 *
 * This placement is single-hop only, by deliberate choice, not an
 * oversight: it does not follow chains of duplicates-of-duplicates. A
 * case is only pulled out of its file-order slot when the case it points
 * at is reached in a single left-to-right pass over the pending cases —
 * if that target is itself pulled out of its own slot first (because it
 * duplicates something else), cases pointing at the target are not
 * re-chased to follow it there. For example, with A duplicating B and B
 * duplicating C, in file order [A, C, B]: B ends up adjacent to C
 * (satisfying B's own adjacency), but A does not end up adjacent to B.
 * Nothing is lost or corrupted when this happens — every case still
 * appears exactly once — and a topological placement that would chase
 * chains correctly is out of scope for this task, since
 * duplicate-of-duplicate chains are rare in practice.
 *
 * `pendingItems` also assumes, rather than guarantees, that `cases`
 * arrives already grouped by scenario — the caller (one cases file per
 * scenario, concatenated) is responsible for that; this function does
 * not re-group.
 */
export function pendingItems(
	feature: Feature,
	scenarios: Scenario[],
	cases: Case[],
): PendingItem[] {
	const out: PendingItem[] = [];
	if (feature.status === "pending")
		out.push({ kind: "feature", item: feature });
	for (const s of scenarios)
		if (s.status === "pending") out.push({ kind: "scenario", item: s });

	const pendingCases = cases.filter((c) => c.status === "pending");
	const placed = new Set<string>();
	const ordered: Case[] = [];
	for (const c of pendingCases) {
		if (placed.has(c.id)) continue;
		ordered.push(c);
		placed.add(c.id);
		for (const d of pendingCases) {
			if (d.duplicate_of === c.id && !placed.has(d.id)) {
				ordered.push(d);
				placed.add(d.id);
			}
		}
	}
	for (const c of ordered) out.push({ kind: "case", item: c });
	return out;
}

function isFeature(item: Feature | Scenario | Case): item is Feature {
	return "purpose" in item;
}

function isScenario(item: Scenario | Case): item is Scenario {
	return "kind" in item;
}

function isCase(item: Feature | Scenario | Case): item is Case {
	return "scenario" in item;
}

function validate<T extends Feature | Scenario | Case>(
	original: T,
	edited: unknown,
): T {
	const schema = isFeature(original)
		? FeatureSchema
		: isScenario(original)
			? ScenarioSchema
			: CaseSchema;
	const result = schema.safeParse(edited);
	if (!result.success) {
		throw new ForgeError(
			`edited item is invalid: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
			{ id: original.id },
		);
	}
	return result.data as T;
}

/** No siblings to collide with: the default for callers that have none. */
const NO_TAKEN_IDS: ReadonlySet<string> = new Set();

/**
 * `takenIds` is every id already present in the item's own file, the item's
 * own included. An edit may rename an item — that is how a model-generated
 * slug gets fixed — but renaming it onto an id a sibling already uses makes
 * two entries indistinguishable, and the review pass then resolves one over
 * the other. Refused by name, so the loop re-asks.
 */
export function applyDecision<T extends Feature | Scenario | Case>(
	item: T,
	decision: Decision,
	edited?: T,
	takenIds: ReadonlySet<string> = NO_TAKEN_IDS,
): T {
	switch (decision) {
		case "approve":
			return { ...item, status: "approved" };
		case "reject":
			if (isFeature(item)) {
				throw new ForgeError(
					"a feature cannot be rejected; edit it or delete .forge/feature.yaml",
					{ id: item.id },
				);
			}
			return { ...item, status: "rejected" };
		case "edit": {
			if (edited === undefined)
				throw new ForgeError("edit needs the edited item", { id: item.id });
			const next = validate(item, edited);
			// A case's `scenario` is not a field of the case, it is which
			// file the case lives in: `.forge/cases/<scenario>.yaml`, whose
			// scenario supplies the oracle its `expected` was written
			// against, and whose name its id is numbered from. Honouring a
			// change here would mean rewriting two files, renumbering the
			// id and re-checking the expected against a different oracle —
			// a file move, not a review decision. Refused by name so the
			// edit is re-asked, rather than half-applied into a file the
			// reviewer never opened.
			if (next.id !== item.id && takenIds.has(next.id))
				throw new ForgeError(
					`id "${next.id}" is already used by another item in the same file; pick an id nothing else uses`,
					{ id: item.id },
				);
			if (isCase(item) && isCase(next) && next.scenario !== item.scenario)
				throw new ForgeError(
					`a case's scenario cannot be changed in review (from "${item.scenario}" to "${next.scenario}"); move the case between .forge/cases/<scenario>.yaml files instead`,
					{ id: item.id },
				);
			return { ...next, status: "edited" };
		}
		case "skip":
			return item;
		default:
			// `Decision` is a plain string union with no schema behind it — a
			// caller holding an unvalidated string typed loosely as `Decision`
			// (via `any`) could reach here at runtime even though every
			// literal is exhausted above. Name the bad value rather than
			// silently returning `undefined`.
			throw new ForgeError(`unrecognized decision "${decision}"`, {
				id: item.id,
			});
	}
}

export function withExpected(c: Case, expected: Expected): Case {
	const result = ExpectedSchema.safeParse(expected);
	if (!result.success) {
		throw new ForgeError(
			`expected is invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
			{ id: c.id },
		);
	}
	return { ...c, expected: result.data };
}
