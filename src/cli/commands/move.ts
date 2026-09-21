import { join } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
	forgePaths,
	listCaseScenarios,
	readAllCases,
	readCases,
	readFeature,
	readScenarios,
	readSuiteIfPresent,
	removeFile,
	rewriteSuiteInclude,
	writeCases,
	writeScenarios,
	writeText,
} from "../../core/files";
import { IMPORTED_SCENARIO_ID } from "../../core/import";
import { moveCase, renameScenario } from "../../core/move";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";

/**
 * A scenario's id becomes the file name `.forge/cases/<id>.yaml`, so it
 * is held to what a file name can safely be: no path separators, no
 * leading dot (which covers `.` and `..`), and not itself ending in the
 * extension the forge appends.
 */
const BARE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The cases file that would answer to `id`, by the names on disk. Compared
 * without case on purpose: on the default macOS filesystem `Old.yaml` and
 * `old.yaml` are the same file, while `readdir` reports one spelling and a
 * lookup by the other misses it. Every place `move` decides whether a file
 * exists asks this, so the verb behaves the same on every filesystem.
 */
function casesFileFor(files: string[], id: string): string | undefined {
	const wanted = fold(id);
	return files.find((f) => fold(f) === wanted);
}

/**
 * Letter case and Unicode normalisation both fold: APFS opens `café.yaml`
 * stored as NFC by its NFD spelling too, and the two strings compare
 * unequal in JavaScript. A hand-written id with a diacritic and a file
 * name that drifted (git stores NFD paths as NFC on macOS by default) is
 * how the two meet.
 */
function fold(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

/**
 * A write after the first one: when it fails, the message has to say what
 * is already on disk and what to do by hand, because the retry the plain
 * error suggests is refused by the guards above (the destination now
 * exists) or impossible (the old id is gone from scenarios.yaml).
 */
async function attempt(work: Promise<void>, afterwards: string): Promise<void> {
	await work.catch((e: unknown) => {
		const message = e instanceof Error ? e.message : String(e);
		throw new ForgeError(`${message}; ${afterwards}`);
	});
}

function requireBareId(id: string): void {
	if (!BARE_ID.test(id) || id.endsWith(".yaml"))
		throw new UsageError(
			`"${id}" cannot name a scenario: it becomes .forge/cases/<id>.yaml, so it takes letters, digits, "-", "_" and "." only, starts with a letter or digit, and does not end in ".yaml"`,
		);
}

/**
 * `forge move`: the two file moves `forge review` refuses to make as
 * decisions. Every check runs before the first write, and the destination
 * is written before the source is touched, so a failure part-way leaves a
 * duplicate to clean up rather than a case that exists nowhere.
 */
export async function moveCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			scenario: { type: "string" },
			case: { type: "string" },
			to: { type: "string" },
		},
		allowPositionals: true,
	});
	const scenarioForm = values.scenario !== undefined;
	const caseForm = values.case !== undefined || values.to !== undefined;
	if (scenarioForm === caseForm)
		throw new UsageError(
			"move takes either --scenario <old> <new> or --case <id> --to <scenario>",
		);
	if (scenarioForm) {
		const [to, ...extra] = positionals;
		if (values.scenario === undefined || to === undefined || extra.length > 0)
			throw new UsageError(
				"--scenario takes exactly two ids: the old one and the new one",
			);
		await moveScenario(values.scenario, to, ctx);
		return;
	}
	if (values.case === undefined || values.to === undefined)
		throw new UsageError("--case <id> and --to <scenario> go together");
	if (positionals.length > 0)
		throw new UsageError(
			`unexpected argument "${positionals[0]}"; --case takes only --to <scenario>`,
		);
	await moveOneCase(values.case, values.to, ctx);
}

async function moveScenario(
	from: string,
	to: string,
	ctx: CliContext,
): Promise<void> {
	requireBareId(to);
	const paths = forgePaths(ctx.forgeDir);
	const scenarios = await readScenarios(ctx.forgeDir);
	// `readCases` answers `[]` for a file that is not there, and a scenario
	// reviewed before `cases` ran for it has none: the rename then must not
	// invent an empty `cases/<new>.yaml`, which every later verb would read
	// as a scenario that already has cases.
	const files = await listCaseScenarios(ctx.forgeDir);
	// The source file is found by the same rule as everything else on
	// disk. A file whose name differs from the id only by case was read
	// (the read resolves case-insensitively on macOS) and then left where
	// it was, with scenarios.yaml renamed around it: the verb reported the
	// count and every later verb dropped those cases in silence.
	const sourceFile = casesFileFor(files, from);
	if (sourceFile !== undefined && sourceFile !== from)
		throw new ForgeError(
			`scenario "${from}" has a cases file spelled "${sourceFile}" (letter case or Unicode normalisation differs); rename one so they match`,
			{ file: join(paths.casesDir, `${sourceFile}.yaml`), id: from },
		);
	const hasFile = sourceFile !== undefined;
	const cases = hasFile ? await readCases(ctx.forgeDir, from) : [];
	const read = await readSuiteIfPresent(ctx.forgeDir);
	const suite = read === null ? null : read.suite;
	const result = renameScenario({ from, to, scenarios, cases, suite });
	// scenarios.yaml is not the only place a name can be taken: a stray
	// `cases/<new>.yaml` with no scenario entry would be overwritten by the
	// write below and its cases lost — and a rename that only changes case
	// wrote the new file onto the old one and then deleted it.
	// A rename that changes only letter case or normalisation would name
	// the source file as the clash below and send the person to move it
	// away — after which the rename "succeeds" with nothing renumbered and
	// the file put back holds cases naming a scenario that no longer
	// exists. The way through is two renames via a temporary id, so that
	// is what the refusal says.
	if (hasFile && fold(to) === fold(from))
		throw new ForgeError(
			`"${to}" differs from "${from}" only in letter case or Unicode normalisation, which is one file on the default macOS filesystem; rename through a temporary id: forge move --scenario ${from} tmp-${to} && forge move --scenario tmp-${to} ${to}`,
			{ file: join(paths.casesDir, `${from}.yaml`), id: to },
		);
	const clash = casesFileFor(files, to);
	if (clash !== undefined)
		throw new ForgeError(
			`cases/${clash}.yaml already exists; pick another id or move that file away first`,
			{ file: join(paths.casesDir, `${clash}.yaml`), id: to },
		);
	// Prepared before the first write, so a suite that cannot be rewritten
	// in place refuses the whole move rather than leaving scenarios.yaml
	// renamed and suite.include stale.
	const occurrences =
		suite === null ? 0 : suite.include.filter((id) => id === from).length;
	const rewrittenSuite =
		read !== null && occurrences > 0
			? rewriteSuiteInclude({
					path: paths.suite,
					text: read.text,
					from,
					to,
					occurrences,
				})
			: null;
	// A file holding `[]` is carried no further: it is the phantom every
	// later verb reads as a scenario that already has cases.
	const keepFile = cases.length > 0;
	const written: string[] = [];
	if (keepFile) {
		await writeCases(ctx.forgeDir, to, result.cases);
		written.push(`cases/${to}.yaml`);
	}
	await attempt(
		writeScenarios(ctx.forgeDir, result.scenarios),
		keepFile
			? `cases/${to}.yaml is already written; delete it by hand and run the move again`
			: "nothing else is written; run the move again",
	);
	written.push("scenarios.yaml");
	if (rewrittenSuite !== null) {
		await attempt(
			writeText(paths.suite, rewrittenSuite),
			`already written: ${written.join(", ")}; change ${from} to ${to} in suite.include by hand${hasFile ? `, then delete cases/${from}.yaml` : ""}`,
		);
		written.push("suite.yaml");
	}
	if (hasFile)
		await removeFile(
			join(paths.casesDir, `${from}.yaml`),
			`already written: ${written.join(", ")}; delete cases/${from}.yaml by hand`,
		);
	ctx.stdout(
		`move: scenario ${from} → ${to}; ${result.renamedIds.size} case(s) renumbered`,
	);
	if (hasFile && !keepFile)
		ctx.stdout(`move: cases/${from}.yaml held no case and was removed`);
	if (rewrittenSuite !== null) ctx.stdout("move: suite.include updated");
	// `import` appends to the scenario by this id and to no other.
	if (from === IMPORTED_SCENARIO_ID)
		ctx.stdout(
			`move: later imports start a new "${IMPORTED_SCENARIO_ID}" scenario; ${to} keeps these cases`,
		);
}

async function moveOneCase(
	caseId: string,
	toId: string,
	ctx: CliContext,
): Promise<void> {
	const paths = forgePaths(ctx.forgeDir);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	const scenarios = await readScenarios(ctx.forgeDir);
	const to = scenarios.find((s) => s.id === toId);
	if (to === undefined)
		throw new ForgeError(`scenario "${toId}" not found`, { id: toId });
	// The case's file is whichever one holds it, not the one its `scenario`
	// field names: the field being wrong is exactly what `review --all`
	// sends people here to fix.
	const all = await readAllCases(ctx.forgeDir);
	// The destination's file is looked up by the scenario's id. A file whose
	// name differs from that id only by case is a different key here and
	// the same file on the default macOS filesystem: the lookup would miss,
	// and the write below would replace the file with the one moved case.
	const spelled = casesFileFor([...all.keys()], toId);
	if (spelled !== undefined && spelled !== toId)
		throw new ForgeError(
			`scenario "${toId}" has a cases file spelled "${spelled}" (letter case or Unicode normalisation differs); rename one so they match`,
			{ file: join(paths.casesDir, `${spelled}.yaml`), id: toId },
		);
	const holders = [...all.keys()].filter((id) =>
		(all.get(id) ?? []).some((c) => c.id === caseId),
	);
	const [fromId, ...others] = holders;
	if (fromId === undefined)
		throw new ForgeError(`case "${caseId}" is not in any cases file`, {
			file: paths.casesDir,
			id: caseId,
		});
	if (others.length > 0)
		throw new ForgeError(
			`case "${caseId}" is in ${holders.length} cases files (${holders.join(", ")}); fix the files so it is in one`,
			{ file: paths.casesDir, id: caseId },
		);
	const result = moveCase({
		caseId,
		from: { id: fromId },
		to,
		fromCases: all.get(fromId) ?? [],
		toCases: all.get(toId) ?? [],
		feature,
	});
	await writeCases(ctx.forgeDir, toId, result.toCases);
	// The last case leaving takes the file with it: a `cases/<id>.yaml`
	// holding `[]` reads to `dedupe` as a scenario to refuse and to `review
	// --all` as one with nothing to approve, and no verb ever removes it.
	// A scenario with no file is the ordinary state before `cases` runs.
	if (result.fromCases.length > 0)
		await attempt(
			writeCases(ctx.forgeDir, fromId, result.fromCases),
			`${result.moved.id} is already written into cases/${toId}.yaml; remove ${caseId} from cases/${fromId}.yaml by hand`,
		);
	else
		await removeFile(
			join(paths.casesDir, `${fromId}.yaml`),
			`${result.moved.id} is already written into cases/${toId}.yaml; delete cases/${fromId}.yaml by hand`,
		);
	ctx.stdout(`move: ${caseId} → ${result.moved.id} (scenario ${toId})`);
	if (result.reopened !== null)
		ctx.stdout(
			`move: ${result.moved.id} re-opened: ${result.reopened} — edit it in \`forge review\` to give it an expected the ${to.oracle} oracle accepts`,
		);
	if (result.fromCases.length === 0)
		ctx.stdout(`move: cases/${fromId}.yaml removed; it held no other case`);
	// Where the case landed decides whether it runs: `emit` selects the
	// approved cases of approved scenarios only.
	if (to.status !== "approved" && to.status !== "edited")
		ctx.stdout(
			`move: scenario ${toId} is ${to.status}, so ${result.moved.id} will not run until the scenario is approved`,
		);
}
