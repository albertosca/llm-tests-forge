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
 * or already reviewed keeps its own file-order position.
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

export function applyDecision<T extends Feature | Scenario | Case>(
	item: T,
	decision: Decision,
	edited?: T,
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
			return { ...validate(item, edited), status: "edited" };
		}
		case "skip":
			return item;
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
