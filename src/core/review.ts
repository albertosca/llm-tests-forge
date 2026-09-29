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
	for (const scenario of scenarios)
		if (scenario.status === "pending")
			out.push({ kind: "scenario", item: scenario });

	const pendingCases = cases.filter((kase) => kase.status === "pending");
	const placed = new Set<string>();
	const ordered: Case[] = [];
	for (const kase of pendingCases) {
		if (placed.has(kase.id)) continue;
		ordered.push(kase);
		placed.add(kase.id);
		for (const duplicate of pendingCases) {
			if (duplicate.duplicate_of === kase.id && !placed.has(duplicate.id)) {
				ordered.push(duplicate);
				placed.add(duplicate.id);
			}
		}
	}
	for (const kase of ordered) out.push({ kind: "case", item: kase });
	return out;
}

/**
 * The pair a decided item makes with its own kind, so a caller narrowing on
 * `kind` gets the item's type out of the same check. The review loop used
 * to hand its `onDecided` a kind and a bare `Feature | Scenario | Case`,
 * which left every caller casting the two back together with `as`.
 *
 * Discriminated by the same shape checks `applyDecision` already picks a
 * schema with — `purpose`, `kind` and `scenario` are required fields of
 * exactly one of the three, and every item in memory came through a zod
 * parse, which strips whatever else the file held. A decision never changes
 * which of the three an item is: each one is `{ ...item, status }`.
 */
export function pendingItemFor(item: Feature | Scenario | Case): PendingItem {
	if (isFeature(item)) return { kind: "feature", item };
	if (isScenario(item)) return { kind: "scenario", item };
	return { kind: "case", item };
}

function isFeature(item: Feature | Scenario | Case): item is Feature {
	return "purpose" in item;
}

function isScenario(item: Feature | Scenario | Case): item is Scenario {
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
			`edited item is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
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
			// Refused before the sibling-collision rule below, not after: a
			// scenario's id cannot be changed to anything at all, so a
			// rename that also lands on a sibling's id was being answered
			// with "pick an id nothing else uses" — advice no free id can
			// satisfy. A scenario's id is the name of `.forge/cases/<id>.yaml`
			// and the value every one of its cases carries in `scenario`.
			// Renaming it here rewrote scenarios.yaml alone: in the same pass
			// every case of that scenario was then refused as naming a
			// scenario "not in scenarios.yaml" — false at that moment, since
			// the file still held it — and the next `llm-tests-forge review` exited 1
			// on everything. Refused by name so the edit is re-asked, rather
			// than half applied across files the reviewer never opened.
			if (isScenario(item) && isScenario(next) && next.id !== item.id)
				throw new ForgeError(
					`a scenario's id cannot be changed in review (from "${item.id}" to "${next.id}"): it names .forge/cases/<id>.yaml; run \`llm-tests-forge move --scenario ${item.id} ${next.id}\``,
					{ id: item.id },
				);
			// Two entries of the same file sharing an id are
			// indistinguishable, and the review pass then resolves one over
			// the other. Reached only by a case or the feature: a scenario's
			// rename is refused above whatever id it picked.
			if (next.id !== item.id && takenIds.has(next.id))
				throw new ForgeError(
					`id "${next.id}" is already used by another item in the same file; pick an id nothing else uses`,
					{ id: item.id },
				);
			// A case's `scenario` is not a field of the case, it is which
			// file the case lives in: `.forge/cases/<scenario>.yaml`, whose
			// scenario supplies the oracle its `expected` was written
			// against, and whose name its id is numbered from. Honouring a
			// change here would mean rewriting two files, renumbering the
			// id and re-checking the expected against a different oracle —
			// a file move, not a review decision. Refused by name so the
			// edit is re-asked, rather than half-applied into a file the
			// reviewer never opened.
			if (isCase(item) && isCase(next) && next.scenario !== item.scenario)
				throw new ForgeError(
					`a case's scenario cannot be changed in review (from "${item.scenario}" to "${next.scenario}"); run \`llm-tests-forge move --case ${item.id} --to ${next.scenario}\``,
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

export function withExpected(kase: Case, expected: Expected): Case {
	const result = ExpectedSchema.safeParse(expected);
	if (!result.success) {
		throw new ForgeError(
			`expected is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
			{ id: kase.id },
		);
	}
	return { ...kase, expected: result.data };
}
