import { join } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
	forgePaths,
	listCaseScenarios,
	readCases,
	readFeature,
	readScenarios,
	writeCases,
	writeFeature,
	writeScenarios,
} from "../../core/files";
import { expectedMatchesOracle } from "../../core/oracle";
import { applyDecision, pendingItems } from "../../core/review";
import type { Case, Feature, Oracle, Scenario } from "../../core/schemas";
import type { CliContext } from "../context";
import { askChoice, askExpectedFor, openInEditor } from "../prompts";
import { runReviewLoop } from "../review-loop";

const ONLY_VALUES = ["feature", "scenarios", "cases"];

function parseOnlyFlag(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (!ONLY_VALUES.includes(raw))
		throw new UsageError(
			`--only "${raw}" is not valid; choose one of: ${ONLY_VALUES.join(", ")}`,
		);
	return raw;
}

export async function reviewCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			scenario: { type: "string" },
			only: { type: "string" },
			all: { type: "boolean" },
		},
	});
	const only = parseOnlyFlag(values.only);
	// `--all` used to parse `--only`, reject an invalid value, and then
	// ignore a valid one: `--all --only feature` approved a scenario's
	// cases while naming a kind it never looks at. There is no honest
	// reading of the pair -- `--all` decides one thing only -- so it is
	// refused rather than silently narrowed or silently widened.
	if (values.all && only !== undefined)
		throw new UsageError(
			"--all cannot be combined with --only; --all approves one scenario's cases",
		);

	// One guard above both paths: `--scenario` used to be trusted on the
	// interactive path, where a typo answered "nothing pending" and exited
	// 0 while `cases`, `dedupe` and `review --all` all named the same bad id
	// and exited 1.
	const paths = forgePaths(ctx.forgeDir);
	// `scenarios` and `feature` below move with the pass: `onDecided`
	// replaces the entry a decision just produced, so the oracle a later
	// case is checked against is the one this pass approved, not the one
	// that was on disk when it started.
	let scenarios = await readScenarios(ctx.forgeDir);
	const named = values.scenario
		? scenarios.find((s) => s.id === values.scenario)
		: undefined;
	if (values.scenario !== undefined && named === undefined)
		throw new ForgeError(`scenario "${values.scenario}" not found`, {
			id: values.scenario,
		});
	// `named` can only be undefined here if --scenario was absent: a
	// --scenario naming nothing already threw above. This is checked
	// before anything is read, so an unusable command line is reported as
	// one even in a directory with no .forge at all.
	if (values.all && named === undefined)
		throw new UsageError("--all requires --scenario");

	const scenarioIds = values.scenario
		? [values.scenario]
		: await listCaseScenarios(ctx.forgeDir);
	const casesById = new Map<string, Case[]>();
	for (const id of scenarioIds)
		casesById.set(id, await readCases(ctx.forgeDir, id));
	// `pendingItems` places one entry per id, so a file holding two under
	// the same one offers the first and passes over the second in silence —
	// and the write-back deliberately applies a decision to at most one
	// entry, so the twin survives untouched and unreviewed forever. Above
	// the --all branch because a twin id is a property of the file, not of
	// the path that opened it. Nothing here fixes the file; saying it out
	// loud, before either pass, is what nobody was doing.
	for (const [scenarioId, list] of casesById) {
		const seen = new Map<string, number>();
		for (const c of list) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
		for (const [caseId, count] of seen)
			if (count > 1)
				ctx.stdout(
					`review: ${join(paths.casesDir, `${scenarioId}.yaml`)} holds ${count} entries under id "${caseId}"; only the first is offered — fix the file`,
				);
	}

	if (named !== undefined && values.all) {
		const id = named.id;
		const feature = await readFeature(ctx.forgeDir);
		const cases = casesById.get(id) ?? [];
		let approved = 0;
		let noExpected = 0;
		let offOracle = 0;
		const updated = cases.map((c) => {
			if (c.status !== "pending") return c;
			if (c.expected === undefined) {
				noExpected += 1;
				return c;
			}
			// Bulk approval is for someone who already read the file, not a
			// way around the oracle contract every other path enforces.
			const problem = expectedMatchesOracle(c.expected, named.oracle, feature);
			if (problem !== null) {
				offOracle += 1;
				ctx.stdout(`review: ${c.id}: ${problem}`);
				return c;
			}
			approved += 1;
			return applyDecision(c, "approve");
		});
		if (approved > 0) await writeCases(ctx.forgeDir, id, updated);
		const notes: string[] = [];
		if (noExpected > 0)
			notes.push(
				`${noExpected} left pending (no expected set — run \`forge review --scenario ${id}\` to fill them in)`,
			);
		if (offOracle > 0)
			notes.push(
				`${offOracle} left pending (expected does not match the ${named.oracle} oracle — see above)`,
			);
		ctx.stdout(
			`review: approved ${approved} pending case(s) of ${id}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
		);
		return;
	}

	let feature = await readFeature(ctx.forgeDir);
	// The list as it was read off disk. The write-back below matches every
	// decision against the file by the id the item had on entry, so it
	// reads from here rather than from the live `scenarios`, which moves
	// with the pass. A scenario's id can no longer change in review, so
	// today the two agree; taking the pre-pass list keeps the write-back
	// correct on its own terms instead of on that rule's.
	const scenariosAsRead = scenarios;
	const allCases = [...casesById.values()].flat();

	const scopedScenarios = values.scenario
		? scenarios.filter((s) => s.id === values.scenario)
		: scenarios;
	const pending = pendingItems(feature, scopedScenarios, allCases);
	const items = only
		? pending.filter((i) => i.kind === only || `${i.kind}s` === only)
		: pending;
	if (items.length === 0) {
		// "nothing pending" has to mean nothing is pending. When --only is
		// what emptied the list, say so and name how much is still pending
		// outside the filter, rather than sending someone away.
		if (only && pending.length > 0)
			ctx.stdout(
				`review: nothing pending matching --only ${only}; ${pending.length} item(s) still pending outside that filter`,
			);
		else ctx.stdout("review: nothing pending");
		return;
	}

	// A case whose scenario is not in scenarios.yaml has no oracle. This
	// used to answer `rubric` and ask the person for a rubric sentence —
	// the wrong question, against a file nobody can review until it is
	// fixed.
	const oracleOf = (c: Case): Oracle => {
		const scenario = scenarios.find((s) => s.id === c.scenario);
		if (scenario === undefined)
			throw new ForgeError(
				`case ${c.id} names scenario "${c.scenario}", which is not in scenarios.yaml`,
				{ file: paths.scenarios, id: c.id },
			);
		return scenario.oracle;
	};
	// Resolved for every case before the first prompt, not when the loop
	// reaches one: decisions are written only after the loop returns, so
	// failing in the middle of a pass would throw away every decision
	// already taken. A broken file is also not a decision to retry — the
	// loop's own catch would re-ask the same unanswerable item forever.
	for (const item of items) if (item.kind === "case") oracleOf(item.item);

	/**
	 * Scenarios whose `oracle` this pass changed, keyed by the id their
	 * cases file is named for — which is the id they had on entry, and
	 * which `applyDecision` will not let an edit change.
	 */
	const oracleChanges = new Map<
		string,
		{ id: string; from: Oracle; to: Oracle }
	>();
	const io = { stdin: ctx.stdin, stdout: ctx.stdout };
	const result = await runReviewLoop({
		items,
		ask: (q, choices) => askChoice(q, choices, io),
		openEditor: openInEditor,
		// The human's expected value answers to the same oracle contract as
		// the model's, checked with the same function.
		askExpected: (c, oracle) =>
			askExpectedFor(c, oracle, io, (expected) =>
				expectedMatchesOracle(expected, oracle, feature),
			),
		// Collisions are per file: scenarios share scenarios.yaml, cases share
		// their scenario's file, and the feature is alone in its own.
		takenIdsFor: (item) => {
			if (item.kind === "scenario") return new Set(scenarios.map((s) => s.id));
			if (item.kind === "case")
				return new Set(
					(casesById.get(item.item.scenario) ?? []).map((c) => c.id),
				);
			return new Set();
		},
		checkExpected: (c, oracle) =>
			c.expected === undefined
				? null
				: expectedMatchesOracle(c.expected, oracle, feature),
		oracleOf,
		onDecided: (kind, item, originalId) => {
			if (kind === "feature") {
				feature = item as Feature;
				return;
			}
			if (kind !== "scenario") return;
			const decided = item as Scenario;
			// Read before the replacement below overwrites it: the old
			// oracle is what says which of its cases this decision
			// invalidates, and it exists nowhere else once the pass moves on.
			const before = scenarios.find((s) => s.id === originalId);
			if (before !== undefined && before.oracle !== decided.oracle)
				oracleChanges.set(originalId, {
					id: decided.id,
					from: before.oracle,
					to: decided.oracle,
				});
			scenarios = scenarios.map((s) => (s.id === originalId ? decided : s));
		},
		print: ctx.stdout,
	});

	// Every decision is matched back to the file by the id the item had
	// when this pass started (`originalId`), never by the id it carries
	// now: an edit is allowed to change the id, and matching on the new one
	// found nothing, wrote nothing, and still reported the edit as applied.
	// Each list is rebuilt from what was read off disk, so a decision that
	// matched nothing cannot invent a file to land in either.
	// One decision belongs to one item. `Map.get` alone applied it to every
	// entry sharing that id AND handed each the same object reference, so a
	// file with two entries under one id came back with the second replaced
	// by a YAML alias of the first -- its input, its expected and its own
	// review gone, reported as "1 approved". Taking the entry out of the map
	// on first hit makes "at most one" structural: the second entry finds
	// nothing and keeps itself. (Carrying an array index instead would mean
	// threading the file position through PendingItem and the loop, which
	// reorders cases; this keeps the guarantee where the write happens.)
	const take = <T>(decided: Map<string, T>, id: string): T | undefined => {
		const hit = decided.get(id);
		if (hit !== undefined) decided.delete(id);
		return hit;
	};

	const decidedFeature = result.decisions.find((d) => d.kind === "feature");
	if (decidedFeature)
		await writeFeature(ctx.forgeDir, decidedFeature.item as Feature);

	const decidedScenarios = new Map(
		result.decisions
			.filter((d) => d.kind === "scenario")
			.map((d) => [d.originalId, d.item as Scenario] as const),
	);
	if (decidedScenarios.size > 0)
		await writeScenarios(
			ctx.forgeDir,
			scenariosAsRead.map((s) => take(decidedScenarios, s.id) ?? s),
		);

	const decidedCases = new Map(
		result.decisions
			.filter((d) => d.kind === "case")
			.map((d) => [d.originalId, d.item as Case] as const),
	);
	// A scenario's oracle is the contract its cases' `expected` was written
	// against, so changing it in review invalidates them wholesale. Nothing
	// used to notice until each case came up again — and `selectCases`
	// refuses the pair, so `estimate`, `emit` and `report` all stopped on a
	// scenario nobody had touched. The cases go back to `pending` with
	// their `expected` kept: it is the reviewer's own answer, and only they
	// can say what it becomes under the new oracle.
	const reopen = (c: Case): Case => ({ ...c, status: "pending" });
	// An edit may rename a case, and `duplicate_of` is the only field that
	// names another case by id. Left behind, the pointer dangles: no data
	// is lost, but `pendingItems` stops placing the pair together and
	// `dedupe`'s own answer reads as being about a case that is not there.
	// Rewritten in the same write as the rename, so the file is never
	// briefly inconsistent on disk.
	const renamedCases = new Map(
		result.decisions
			.filter((d) => d.kind === "case" && d.originalId !== d.id)
			.map((d) => [d.originalId, d.id] as const),
	);
	const followRename = (c: Case): Case => {
		const renamed =
			c.duplicate_of === undefined
				? undefined
				: renamedCases.get(c.duplicate_of);
		return renamed === undefined ? c : { ...c, duplicate_of: renamed };
	};
	let totalReopened = 0;
	for (const [id, list] of casesById) {
		const oracleChange = oracleChanges.get(id);
		const decided = list.some((c) => decidedCases.has(c.id));
		if (!decided && oracleChange === undefined) continue;
		let next = list.map((c) => followRename(take(decidedCases, c.id) ?? c));
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
				return reopen(c);
			});
			ctx.stdout(
				`review: scenario ${oracleChange.id} changed oracle ${oracleChange.from} → ${oracleChange.to}; ${reopened} case(s) re-opened`,
			);
			totalReopened += reopened;
		}
		// An oracle change whose cases all still fit leaves the file exactly
		// as it was read, and a file no decision touched is not rewritten.
		if (decided || reopened > 0) await writeCases(ctx.forgeDir, id, next);
	}
	const s = result.summary;
	// `skipped` counts the items a person answered "skip" to; it is not the
	// same set as "still pending", which also holds everything --only
	// filtered out of this pass. Every decision leaves its item approved,
	// rejected or edited, so what stays pending is exactly what was pending
	// on entry minus the decisions taken — plus the cases an oracle change
	// re-opened, which are pending now whether or not they were on entry,
	// and which the line reports on their own so the total adds up.
	const stillPending = pending.length - result.decisions.length + totalReopened;
	ctx.stdout(
		`review: ${s.approved} approved, ${s.rejected} rejected, ${s.edited} edited, ${s.skipped} skipped, ${totalReopened} re-opened, ${stillPending} still pending`,
	);
}
