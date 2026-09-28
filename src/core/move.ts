import { sameInput } from "./compare";
import { ForgeError } from "./errors";
import { nextCaseId } from "./ids";
import { expectedMatchesOracle } from "./oracle";
import type { Case, Feature, Scenario, Suite } from "./schemas";

/**
 * The two moves `llm-tests-forge review` refuses to make as decisions, because each
 * one rewrites files the reviewer never opened: a scenario's id names
 * `.forge/cases/<id>.yaml` and is the prefix every one of its cases is
 * numbered from, and a case's `scenario` is which of those files it lives
 * in. Both are pure over the in-memory lists; the command around them does
 * the reads, writes the destination before it touches the source, and
 * deletes last.
 */

export interface RenameScenarioArgs {
	from: string;
	to: string;
	scenarios: Scenario[];
	/** The cases file of `from`, as read. */
	cases: Case[];
	/** `null` when there is no suite.yaml yet. */
	suite: Suite | null;
}

export interface RenameScenarioResult {
	scenarios: Scenario[];
	cases: Case[];
	suite: Suite | null;
	/** Old case id to new, for every case that was renumbered. */
	renamedIds: Map<string, string>;
}

/**
 * The scenario keeps everything but its id — a rename is not a review
 * decision about it, so its status stands. A case of `from` whose id
 * carries the `<from>-` prefix is renumbered to `<to>-` with the same
 * number, and its `duplicate_of` follows the same map; a hand-written id
 * without the prefix moves as it is. A case in the file that names another
 * scenario is a hand edit this verb does not judge: it is left exactly as
 * it was, so the only record of where it was meant to go survives.
 */
export function renameScenario(
	request: RenameScenarioArgs,
): RenameScenarioResult {
	const { from, to: destination, suite } = request;
	const entries = request.scenarios.filter(
		(scenario) => scenario.id === from,
	).length;
	if (entries === 0)
		throw new ForgeError(`scenario "${from}" is not in scenarios.yaml`, {
			id: from,
		});
	// Two entries under one id would both be renamed, and the file would
	// hold the twin under the new name as well; refused, as a twin case id
	// is below, so the file is fixed rather than rewritten around.
	if (entries > 1)
		throw new ForgeError(
			`scenarios.yaml holds ${entries} entries under id "${from}"; fix the file first`,
			{ id: from },
		);
	if (request.scenarios.some((scenario) => scenario.id === destination))
		throw new ForgeError(
			`scenario "${destination}" already exists in scenarios.yaml; pick an id nothing else uses`,
			{ id: destination },
		);
	const scenarios = request.scenarios.map((scenario) =>
		scenario.id === from ? { ...scenario, id: destination } : scenario,
	);
	const prefix = `${from}-`;
	const renamedIds = new Map<string, string>();
	for (const kase of request.cases)
		if (kase.scenario === from && kase.id.startsWith(prefix))
			renamedIds.set(kase.id, `${destination}-${kase.id.slice(prefix.length)}`);
	// A hand-written `new-01` sitting next to `old-01` would come out of the
	// rename as two entries under one id, which the review pass resolves
	// one over the other. Refused before anything is rewritten.
	for (const [oldId, newId] of renamedIds) {
		const taken = request.cases.find(
			(kase) => kase.id === newId && !renamedIds.has(kase.id),
		);
		if (taken !== undefined)
			throw new ForgeError(
				`case ${oldId} would become ${newId}, an id the file already holds; rename one of them by hand first`,
				{ id: oldId },
			);
	}
	const cases = request.cases.map((kase) => {
		if (kase.scenario !== from) return kase;
		const next = {
			...kase,
			scenario: destination,
			id: renamedIds.get(kase.id) ?? kase.id,
		};
		const pointer =
			kase.duplicate_of === undefined
				? undefined
				: renamedIds.get(kase.duplicate_of);
		return pointer === undefined ? next : { ...next, duplicate_of: pointer };
	});
	const nextSuite =
		suite === null
			? null
			: {
					...suite,
					include: suite.include.map((id) => (id === from ? destination : id)),
				};
	return { scenarios, cases, suite: nextSuite, renamedIds };
}

export interface MoveCaseArgs {
	caseId: string;
	/** The scenario whose file holds the case; only its id is needed. */
	from: Pick<Scenario, "id">;
	to: Scenario;
	fromCases: Case[];
	toCases: Case[];
	feature: Feature;
}

export interface MoveCaseResult {
	fromCases: Case[];
	toCases: Case[];
	moved: Case;
	/**
	 * The sentence from `expectedMatchesOracle` when the destination's
	 * oracle does not accept the case's expected — the case is then
	 * `pending` again, with the expected kept for the reviewer to rewrite.
	 * `null` when the review it had stands.
	 */
	reopened: string | null;
}

function withoutDuplicateOf(kase: Case): Case {
	const { duplicate_of: _dropped, ...rest } = kase;
	return rest;
}

/**
 * The moved case is numbered after the destination's last case and takes
 * the destination's id as its `scenario`. `duplicate_of` names a case in
 * the same file, so the moved case drops its own and every sibling pointing
 * at it loses the pointer: neither end of the pair shares a file with the
 * other any more.
 */
export function moveCase(request: MoveCaseArgs): MoveCaseResult {
	const { caseId, from, to: destination, feature } = request;
	const entries = request.fromCases.filter((kase) => kase.id === caseId);
	const found = entries[0];
	if (found === undefined)
		throw new ForgeError(`case "${caseId}" is not in scenario "${from.id}"`, {
			id: caseId,
		});
	// A file holding two entries under one id is a state review warns
	// about and sends people here for. Moving "the" case would take the
	// first and drop every entry under the id from the source: one case
	// moved, one lost in silence.
	if (entries.length > 1)
		throw new ForgeError(
			`cases file of scenario "${from.id}" holds ${entries.length} entries under id "${caseId}"; fix the file first`,
			{ id: caseId },
		);
	// The source and the destination would be the same file: writing it and
	// then removing the case from it would undo the write.
	if (from.id === destination.id)
		throw new ForgeError(
			`case "${caseId}" is already in scenario "${destination.id}"`,
			{
				id: caseId,
			},
		);
	// A move that wrote the destination and then failed to remove the
	// source leaves the same case under two ids; re-running it would add a
	// third. The input is what makes a case the same case, so a
	// destination case with this input refuses the move by name.
	const twin = request.toCases.find((kase) =>
		sameInput(kase.input, found.input),
	);
	if (twin !== undefined)
		throw new ForgeError(
			`case "${caseId}" has the same input as "${twin.id}", already in scenario "${destination.id}"; delete one of them`,
			{ id: caseId },
		);
	// Only a review already given is worth re-opening: a rejected case
	// stays rejected under any oracle, as it does when its own scenario's
	// oracle changes in review.
	const reviewed = found.status === "approved" || found.status === "edited";
	const reopened =
		found.expected === undefined || !reviewed
			? null
			: expectedMatchesOracle(found.expected, destination.oracle, feature);
	const moved: Case = {
		...withoutDuplicateOf(found),
		id: nextCaseId(destination.id, request.toCases),
		scenario: destination.id,
		status: reopened === null ? found.status : "pending",
	};
	const fromCases = request.fromCases
		.filter((kase) => kase.id !== caseId)
		.map((kase) =>
			kase.duplicate_of === caseId ? withoutDuplicateOf(kase) : kase,
		);
	return { fromCases, toCases: [...request.toCases, moved], moved, reopened };
}
