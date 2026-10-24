import { join } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
	type CaseFileFingerprint,
	caseFileFingerprint,
	forgePaths,
	listCaseScenarios,
	type ReadCaseFile,
	readCaseFile,
	readFeature,
	readScenarios,
	writeCases,
	writeFeature,
	writeScenarios,
} from "../../core/files";
import { expectedMatchesOracle } from "../../core/oracle";
import { pendingItems } from "../../core/review";
import type { Case, Oracle } from "../../core/schemas";
import { colorEnabled, palette, renderItem } from "../colors";
import type { CliContext } from "../context";
import { askChoice, askExpectedFor, openInEditor } from "../prompts";
import { frameFor } from "../review-frame";
import { runReviewLoop } from "../review-loop";
import { applyReviewDecisions, takeOnce } from "../review-writeback";
import { reviewAllCommand } from "./review-all";

const ONLY_VALUES = ["feature", "scenarios", "cases"];

function parseOnlyFlag(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (!ONLY_VALUES.includes(raw))
		throw new UsageError(
			`--only "${raw}" is not valid; choose one of: ${ONLY_VALUES.join(", ")}`,
		);
	return raw;
}

/**
 * Why the write-back must not overwrite one cases file, or `null` when the
 * file is exactly as this pass read it: removed, or changed (a different
 * size or modification time than the fingerprint taken on reading it).
 */
async function writeBackSkipReason(
	forgeDirectory: string,
	scenarioId: string,
	before: CaseFileFingerprint,
): Promise<string | null> {
	const after = await caseFileFingerprint(forgeDirectory, scenarioId);
	if (after === null) return "was removed";
	if (
		before.modifiedAtInMilliseconds !== after.modifiedAtInMilliseconds ||
		before.sizeInBytes !== after.sizeInBytes
	)
		return "changed on disk";
	return null;
}

export async function reviewCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
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
	const paths = forgePaths(context.forgeDirectory);
	// `scenarios` and `feature` below move with the pass: `onDecided`
	// replaces the entry a decision just produced, so the oracle a later
	// case is checked against is the one this pass approved, not the one
	// that was on disk when it started.
	let scenarios = await readScenarios(context.forgeDirectory);
	const named = values.scenario
		? scenarios.find((scenario) => scenario.id === values.scenario)
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
		: await listCaseScenarios(context.forgeDirectory);
	const casesById = new Map<string, Case[]>();
	// Every cases file that existed, with a snapshot of its size and
	// modification time taken as its cases were read. The write-back below
	// walks these, not `casesById`, and takes the same fingerprint again
	// just before it writes a file back, so it can tell a file exactly as
	// it was read apart from one removed, or replaced with something else,
	// while this pass was open. The fingerprint travels with the cases, so
	// no lookup can come back empty; a scenario with no file has nothing to
	// write back and is simply absent here.
	const readCaseFiles = new Map<string, ReadCaseFile>();
	for (const id of scenarioIds) {
		const caseFile = await readCaseFile(context.forgeDirectory, id);
		casesById.set(id, caseFile?.cases ?? []);
		if (caseFile !== null) readCaseFiles.set(id, caseFile);
	}
	// `pendingItems` places one pending entry per id, so a file holding two
	// under the same one offers the first pending one and passes over the
	// others in silence — the decision lands on exactly the entry offered
	// (see the write-back below), and each other twin waits for a later
	// pass. An approved twin is not offered at all. Above
	// the --all branch because a twin id is a property of the file, not of
	// the path that opened it. Nothing here fixes the file; saying it out
	// loud, before either pass, is what nobody was doing.
	for (const [scenarioId, list] of casesById) {
		const seen = new Map<string, number>();
		for (const caseEntry of list)
			seen.set(caseEntry.id, (seen.get(caseEntry.id) ?? 0) + 1);
		for (const [caseId, count] of seen)
			if (count > 1)
				context.stdout(
					`review: ${join(paths.casesDir, `${scenarioId}.yaml`)} holds ${count} entries under id "${caseId}"; a pass offers only the first pending one — fix the file`,
				);
	}
	// The same id in two files is not a twin the per-file warning sees, and
	// `pendingItems` offers one entry per id: the second file's case is
	// reached only on a later pass, after the first is decided. Said out
	// loud so the "still pending" count reads right.
	const filesById = new Map<string, string[]>();
	for (const [scenarioId, list] of casesById)
		for (const caseId of new Set(list.map((caseEntry) => caseEntry.id)))
			filesById.set(caseId, [...(filesById.get(caseId) ?? []), scenarioId]);
	for (const [caseId, files] of filesById)
		if (files.length > 1)
			context.stdout(
				`review: id "${caseId}" is in ${files.map((scenarioId) => join(paths.casesDir, `${scenarioId}.yaml`)).join(" and ")}; each pass offers the first pending one — give them distinct ids`,
			);
	if (named !== undefined && values.all) {
		await reviewAllCommand({
			scenario: named,
			cases: casesById.get(named.id) ?? [],
			feature: await readFeature(context.forgeDirectory),
			forgeDirectory: context.forgeDirectory,
			stdout: context.stdout,
		});
		return;
	}

	let feature = await readFeature(context.forgeDirectory);
	// The list as it was read off disk. The write-back below matches every
	// decision against the file by the id the item had on entry, so it
	// reads from here rather than from the live `scenarios`, which moves
	// with the pass. A scenario's id can no longer change in review, so
	// today the two agree; taking the pre-pass list keeps the write-back
	// correct on its own terms instead of on that rule's.
	const scenariosAsRead = scenarios;
	const allCases = [...casesById.values()].flat();
	/** Which file each case was read from; a case's `scenario` should agree. */
	const fileOf = new Map<Case, string>();
	for (const [id, list] of casesById)
		for (const caseEntry of list) fileOf.set(caseEntry, id);

	const scopedScenarios = values.scenario
		? scenarios.filter((scenario) => scenario.id === values.scenario)
		: scenarios;
	const pending = pendingItems(feature, scopedScenarios, allCases);
	const items = only
		? pending.filter(
				(pendingItem) =>
					pendingItem.kind === only || `${pendingItem.kind}s` === only,
			)
		: pending;
	// Counted on disk, not from `pendingItems`: that list offers one entry
	// per id, so a twin id across files was counted once and the second
	// copy, still pending, read as none — in the summary line and in the
	// --only line alike.
	const pendingOnDisk =
		(feature.status === "pending" ? 1 : 0) +
		scopedScenarios.filter((scenario) => scenario.status === "pending").length +
		allCases.filter((caseEntry) => caseEntry.status === "pending").length;
	if (items.length === 0) {
		// "nothing pending" has to mean nothing is pending. When --only is
		// what emptied the list, say so and name how much is still pending
		// outside the filter, rather than sending someone away.
		if (only && pending.length > 0)
			context.stdout(
				`review: nothing pending matching --only ${only}; ${pendingOnDisk} item(s) still pending outside that filter`,
			);
		else context.stdout("review: nothing pending");
		return;
	}

	// A case whose scenario is not in scenarios.yaml has no oracle. This
	// used to answer `rubric` and ask the person for a rubric sentence —
	// the wrong question, against a file nobody can review until it is
	// fixed.
	const oracleOf = (caseEntry: Case): Oracle => {
		const scenario = scenarios.find(
			(candidate) => candidate.id === caseEntry.scenario,
		);
		if (scenario === undefined)
			throw new ForgeError(
				`case ${caseEntry.id} names scenario "${caseEntry.scenario}", which is not in scenarios.yaml`,
				{ file: paths.scenarios, id: caseEntry.id },
			);
		return scenario.oracle;
	};
	// Resolved for every case before the first prompt, not when the loop
	// reaches one: decisions are written only after the loop returns, so
	// failing in the middle of a pass would throw away every decision
	// already taken. A broken file is also not a decision to retry — the
	// loop's own catch would re-ask the same unanswerable item forever.
	for (const item of items) {
		if (item.kind !== "case") continue;
		oracleOf(item.item);
		// A decision is written back to the file its case's `scenario`
		// names. A hand edit put a case naming another existing scenario in
		// this file: a decision on it would land nowhere, so it is refused
		// before the first prompt, as `--all` refuses it — and only for a
		// case this pass will offer, so a broken entry nobody is asked
		// about does not block the feature's or the scenarios' review.
		const file = fileOf.get(item.item) ?? item.item.scenario;
		if (item.item.scenario !== file) {
			const path = join(paths.casesDir, `${file}.yaml`);
			throw new ForgeError(
				`case ${item.item.id} names scenario "${item.item.scenario}" but lives in ${path}; run \`llm-tests-forge move --case ${item.item.id} --to ${item.item.scenario}\` or fix the file`,
				{ file: path, id: item.item.id },
			);
		}
	}

	/**
	 * Scenarios whose `oracle` this pass changed, keyed by the id their
	 * cases file is named for — which is the id they had on entry, and
	 * which `applyDecision` will not let an edit change.
	 */
	const oracleChanges = new Map<
		string,
		{ id: string; from: Oracle; to: Oracle }
	>();
	/** Case ids this pass has decided, per file, for `takenIdsFor`. */
	const decidedIdsIn = new Map<string, Set<string>>();
	// Color only for a person at a terminal: a redirected or piped run, and
	// every test, keeps the plain text it always had.
	const paint = palette(colorEnabled(process.env, process.stdout.isTTY));
	// Arms "Ctrl+C ends the input" right before the first question this
	// pass asks, and hands over the only reader the questions accept.
	// `--all` returns above without ever reaching here, so it never arms
	// it: it asks nothing, and an interrupt during its model calls should
	// exit as it always did, not be mistaken for the middle of a review pass.
	const pass = context.startInteractivePass();
	const io = { stdin: pass.read, stdout: context.stdout };
	const result = await runReviewLoop({
		items,
		ask: (question, choices) => askChoice(paint.prompt(question), choices, io),
		// The editor owns the terminal while it runs: a Ctrl+C there is the
		// editor's (Vim leaves insert mode with it), never the end of the pass.
		openEditor: (yamlText) => pass.whileEditing(() => openInEditor(yamlText)),
		// The human's expected value answers to the same oracle contract as
		// the model's, checked with the same function.
		askExpected: (caseEntry, oracle) =>
			askExpectedFor(caseEntry, oracle, io, (expected) =>
				expectedMatchesOracle(expected, oracle, feature),
			),
		// Collisions are per file: cases share their scenario's file. A
		// case's file is the ids read off disk plus the ids this pass has
		// already given its cases: two edits renaming onto the same new id
		// were both accepted, and the file came back with two entries under
		// it and a `duplicate_of` pointing at an ambiguous target. The
		// feature is alone in its own file, and a scenario's id cannot be
		// changed in review at all (`applyDecision` refuses that rename
		// before it asks for any taken ids; tests/cli/main.test.ts pins
		// that), so neither has an id to collide with here.
		takenIdsFor: (item) =>
			item.kind === "case"
				? new Set([
						...(casesById.get(item.item.scenario) ?? []).map(
							(caseEntry) => caseEntry.id,
						),
						// Stryker disable next-line ArrayDeclaration: the mutant adds one
						// made-up id to the taken ids of a file this pass decided nothing
						// in; it matters only to an edit that renames a case onto that
						// exact made-up text, and every other id behaves the same.
						...(decidedIdsIn.get(item.item.scenario) ?? []),
					])
				: new Set(),
		checkExpected: (expected, oracle) =>
			expectedMatchesOracle(expected, oracle, feature),
		oracleOf,
		onDecided: (item, originalId) => {
			if (item.kind === "feature") {
				feature = item.item;
				return;
			}
			if (item.kind === "case") {
				const taken = decidedIdsIn.get(item.item.scenario) ?? new Set();
				taken.add(item.item.id);
				decidedIdsIn.set(item.item.scenario, taken);
				return;
			}
			const decided = item.item;
			// Read before the replacement below overwrites it: the old
			// oracle is what says which of its cases this decision
			// invalidates, and it exists nowhere else once the pass moves on.
			const before = scenarios.find((scenario) => scenario.id === originalId);
			if (before !== undefined && before.oracle !== decided.oracle)
				oracleChanges.set(originalId, {
					id: decided.id,
					from: before.oracle,
					to: decided.oracle,
				});
			scenarios = scenarios.map((scenario) =>
				scenario.id === originalId ? decided : scenario,
			);
		},
		print: (line) =>
			context.stdout(
				line.startsWith("cannot apply:") ? paint.error(line) : line,
			),
		render: (item, place) =>
			renderItem(item, paint, frameFor(item, place, { feature, scenarios })),
	});

	/**
	 * The pass's case decisions for one file, keyed by the entry the pass
	 * offered — the object read off disk, which is its position in the
	 * file. Keyed by id, a decision landed on the first entry under that
	 * id: across files, over an approved case in an earlier file; within
	 * one file, over an approved twin of the pending entry offered. A
	 * case's `scenario` names its file and cannot change in review, so it
	 * is the file a decision belongs to.
	 */
	const decidedCasesIn = (id: string): Map<Case, Case> =>
		new Map(
			result.decisions.flatMap((decision) =>
				decision.kind === "case" &&
				decision.offered.kind === "case" &&
				decision.item.scenario === id
					? [[decision.offered.item, decision.item] as const]
					: [],
			),
		);
	/**
	 * What the write-back has done so far, so a write that fails part-way
	 * can say which files landed and which did not: the error used to name
	 * only the file that failed, and after a second Ctrl+C that was all the
	 * person saw before the process ended.
	 */
	const written: string[] = [];
	const processedCaseFiles = new Set<string>();
	let attempting = "";
	const writing = async (
		label: string,
		write: () => Promise<void>,
	): Promise<void> => {
		attempting = label;
		await write();
		written.push(label);
		attempting = "";
	};
	/** The cases files this write-back would still have written. */
	const caseFilesNotReached = (): string[] =>
		[...readCaseFiles]
			.filter(
				([id, { cases: list }]) =>
					!processedCaseFiles.has(id) &&
					applyReviewDecisions({
						list,
						decidedCases: decidedCasesIn(id),
						oracleChange: oracleChanges.get(id),
						feature,
					}).touched,
			)
			.map(([id]) => `cases/${id}.yaml`);
	const scenariosDecided = result.decisions.some(
		(decision) => decision.kind === "scenario",
	);

	// Everything from the first write to the summary line runs guarded: a
	// second Ctrl+C in here lets it finish, then exits 130, rather than
	// stopping between two files. Before this point a second Ctrl+C still
	// exits at once, and nothing has been written.
	await pass.whileWriting(async () => {
		try {
			const decidedFeature = result.decisions.find(
				(decision) => decision.kind === "feature",
			);
			if (decidedFeature)
				await writing("feature.yaml", () =>
					writeFeature(context.forgeDirectory, decidedFeature.item),
				);

			const decidedScenarios = new Map(
				result.decisions
					.filter((decision) => decision.kind === "scenario")
					.map((decision) => [decision.originalId, decision.item] as const),
			);
			if (decidedScenarios.size > 0)
				await writing("scenarios.yaml", () =>
					writeScenarios(
						context.forgeDirectory,
						scenariosAsRead.map(
							(scenario) => takeOnce(decidedScenarios, scenario.id) ?? scenario,
						),
					),
				);

			let totalReopened = 0;
			// Decisions belonging to a file the write-back below refused to touch:
			// counted so the summary can say how many of "N approved" and the rest
			// never actually reached disk, instead of reporting them as landed.
			let totalDecisionsNotWritten = 0;
			for (const [id, { cases: list, fingerprint: before }] of readCaseFiles) {
				processedCaseFiles.add(id);
				const oracleChange = oracleChanges.get(id);
				const decidedCases = decidedCasesIn(id);
				// Read before `applyReviewDecisions` below drains `decidedCases` via
				// `takeOnce`: by the time the write-back guard needs this count, the
				// map it would read is already empty, regardless of how many
				// decisions this file actually had.
				const decidedCaseCount = decidedCases.size;
				// An oracle change against a file holding nothing re-opens nothing
				// and writes nothing; the pass below reports it, together with the
				// scenarios that have no file at all, so one change is announced
				// once rather than as both a count of zero and a "no cases yet".
				if (list.length === 0) continue;
				const { next, reopened, touched } = applyReviewDecisions({
					list,
					decidedCases,
					oracleChange,
					feature,
				});
				// The file this pass is about to overwrite may have been removed, or
				// replaced with something else entirely, while a person was answering
				// it — by hand, or by another process. Compared against the
				// fingerprint taken when this pass read the file, not just checked for
				// existence: a file removed and then recreated with different content
				// is back by the time this runs, and existence alone would miss that
				// it is not the file this pass read. Decided before anything about
				// this file is announced: a file the guard skips re-opened nothing on
				// disk, so its re-opens are not counted, and its decisions go back
				// into "still pending" through `totalDecisionsNotWritten`.
				const skipReason = touched
					? await writeBackSkipReason(context.forgeDirectory, id, before)
					: null;
				if (skipReason !== null) {
					// Name only what this file actually lost: a file touched by the
					// oracle change alone held no decision of this pass, and "its
					// decisions were not written" sent the person looking for some.
					// The oracle change itself did land, in scenarios.yaml, so it is
					// still announced — just without a count nobody applied.
					const lost = [
						...(decidedCaseCount > 0 ? ["its decisions were not written"] : []),
						...(reopened > 0 ? ["its cases were not re-opened"] : []),
					];
					context.stdout(
						`review: cases/${id}.yaml ${skipReason} during the pass; ${lost.join(" and ")}`,
					);
					if (oracleChange !== undefined)
						context.stdout(
							`review: scenario ${oracleChange.id} changed oracle ${oracleChange.from} → ${oracleChange.to} (written to scenarios.yaml)`,
						);
					totalDecisionsNotWritten += decidedCaseCount;
					continue;
				}
				if (oracleChange !== undefined) {
					context.stdout(
						// What to do next, not just what happened: a re-opened case keeps
						// the expected it was approved with, which the new oracle no
						// longer accepts, so approving it again is refused until it is
						// edited. Nothing said so, and the next pass looked broken. At
						// zero there is nothing to edit, so the instruction is left off
						// rather than sending someone to look for cases that do not exist.
						`review: scenario ${oracleChange.id} changed oracle ${oracleChange.from} → ${oracleChange.to}; ${reopened} case(s) re-opened${reopened > 0 ? " — edit each to give it an expected the new oracle accepts" : ""}`,
					);
					totalReopened += reopened;
				}
				if (touched)
					await writing(`cases/${id}.yaml`, () =>
						writeCases(context.forgeDirectory, id, next),
					);
			}
			// The pass above walks the cases files, so a scenario whose oracle this
			// pass changed before `cases` ever ran for it said nothing at all — and
			// the change is exactly the one that decides what every case generated
			// afterwards has to look like. There is no count to report and nothing
			// to re-open; the line exists so the change is on the record.
			for (const [id, change] of oracleChanges) {
				if ((casesById.get(id) ?? []).length > 0) continue;
				context.stdout(
					`review: scenario ${change.id} changed oracle ${change.from} → ${change.to}; no cases yet`,
				);
			}
			const summary = result.summary;
			// `skipped` counts the items a person answered "skip" to; it is not the
			// same set as "still pending", which also holds everything --only
			// filtered out of this pass. Every decision that lands leaves its item
			// approved, rejected or edited, so what stays pending is what was
			// pending on entry minus the decisions taken, plus back the decisions
			// the write-back refused (their items are as the pass found them) —
			// plus the cases an oracle change re-opened, which are pending now
			// whether or not they were on entry, and which the line reports on
			// their own so the total adds up.
			const stillPending =
				pendingOnDisk -
				result.decisions.length +
				totalDecisionsNotWritten +
				totalReopened;
			// The counts above stay exactly what the loop decided, even for a
			// decision the write-back above refused: "2 approved" is true of the
			// pass regardless of whether both landed. This clause is what says some
			// of them did not reach disk, without pretending they were never taken.
			const notWrittenSuffix =
				totalDecisionsNotWritten > 0
					? `; ${totalDecisionsNotWritten} decision(s) not written`
					: "";
			context.stdout(
				`review: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.edited} edited, ${summary.skipped} skipped, ${totalReopened} re-opened, ${stillPending} still pending${notWrittenSuffix}`,
			);
		} catch (error) {
			// Only a failed write is annotated; any other failure is not
			// about what reached disk.
			if (!(error instanceof ForgeError) || attempting === "") throw error;
			const notWritten = [
				attempting,
				...(scenariosDecided && attempting === "feature.yaml"
					? ["scenarios.yaml"]
					: []),
				...caseFilesNotReached(),
			];
			throw new ForgeError(
				`${error.message}; the write-back stopped there: already written: ${written.length > 0 ? written.join(", ") : "nothing"}; not written: ${notWritten.join(", ")}`,
			);
		}
	});
}
