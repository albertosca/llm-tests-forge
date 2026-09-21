import { unlink } from "node:fs/promises";
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
	renameSuiteInclude,
	writeCases,
	writeScenarios,
} from "../../core/files";
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
	const hasFile = files.includes(from);
	const cases = await readCases(ctx.forgeDir, from);
	const suite = await readSuiteIfPresent(ctx.forgeDir);
	const result = renameScenario({ from, to, scenarios, cases, suite });
	// scenarios.yaml is not the only place a name can be taken: a stray
	// `cases/<new>.yaml` with no scenario entry would be overwritten by the
	// write below and its cases lost. Compared without case on purpose —
	// on the default macOS filesystem `Old.yaml` and `old.yaml` are the
	// same file, so a rename that only changes case wrote the new file
	// onto the old one and then deleted it. Refused the same way on every
	// filesystem, so the behaviour does not depend on where the repo is
	// checked out.
	const clash = files.find((f) => f.toLowerCase() === to.toLowerCase());
	if (clash !== undefined)
		throw new ForgeError(
			`cases/${clash}.yaml already exists; pick another id or move that file away first`,
			{ file: join(paths.casesDir, `${clash}.yaml`), id: to },
		);
	if (hasFile) await writeCases(ctx.forgeDir, to, result.cases);
	await writeScenarios(ctx.forgeDir, result.scenarios);
	const suiteChanged = suite?.include.includes(from) === true;
	if (suiteChanged) await renameSuiteInclude(ctx.forgeDir, from, to);
	if (hasFile) await unlink(join(paths.casesDir, `${from}.yaml`));
	ctx.stdout(
		`move: scenario ${from} → ${to}; ${result.renamedIds.size} case(s) renumbered`,
	);
	if (suiteChanged) ctx.stdout("move: suite.include updated");
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
	const spelled = [...all.keys()].find(
		(id) => id !== toId && id.toLowerCase() === toId.toLowerCase(),
	);
	if (spelled !== undefined)
		throw new ForgeError(
			`scenario "${toId}" has a cases file spelled "${spelled}"; rename one so they match`,
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
		await writeCases(ctx.forgeDir, fromId, result.fromCases);
	else await unlink(join(paths.casesDir, `${fromId}.yaml`));
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
