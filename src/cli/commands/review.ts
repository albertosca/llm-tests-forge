import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
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

	// One guard above both paths: `--scenario` used to be trusted on the
	// interactive path, where a typo answered "nothing pending" and exited
	// 0 while `cases`, `dedupe` and `review --all` all named the same bad id
	// and exited 1.
	const scenarios = await readScenarios(ctx.forgeDir);
	const named = values.scenario
		? scenarios.find((s) => s.id === values.scenario)
		: undefined;
	if (values.scenario !== undefined && named === undefined)
		throw new ForgeError(`scenario "${values.scenario}" not found`, {
			id: values.scenario,
		});
	if (values.all) {
		// `named` can only be undefined here if --scenario was absent: a
		// --scenario naming nothing already threw above. This is checked
		// before the feature is read, so an unusable command line is
		// reported as one even in a directory with no .forge at all.
		if (named === undefined) throw new UsageError("--all requires --scenario");
		const id = named.id;
		const feature = await readFeature(ctx.forgeDir);
		const cases = await readCases(ctx.forgeDir, id);
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

	const feature = await readFeature(ctx.forgeDir);
	const scenarioIds = values.scenario
		? [values.scenario]
		: await listCaseScenarios(ctx.forgeDir);
	const casesById = new Map<string, Case[]>();
	for (const id of scenarioIds)
		casesById.set(id, await readCases(ctx.forgeDir, id));
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

	const oracleOf = (scenarioId: string): Oracle =>
		scenarios.find((s) => s.id === scenarioId)?.oracle ?? "rubric";
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
			scenarios.map((s) => take(decidedScenarios, s.id) ?? s),
		);

	const decidedCases = new Map(
		result.decisions
			.filter((d) => d.kind === "case")
			.map((d) => [d.originalId, d.item as Case] as const),
	);
	for (const [id, list] of casesById) {
		if (!list.some((c) => decidedCases.has(c.id))) continue;
		await writeCases(
			ctx.forgeDir,
			id,
			list.map((c) => take(decidedCases, c.id) ?? c),
		);
	}
	const s = result.summary;
	// `skipped` counts the items a person answered "skip" to; it is not the
	// same set as "still pending", which also holds everything --only
	// filtered out of this pass. Every decision leaves its item approved,
	// rejected or edited, so what stays pending is exactly what was pending
	// on entry minus the decisions taken.
	const stillPending = pending.length - result.decisions.length;
	ctx.stdout(
		`review: ${s.approved} approved, ${s.rejected} rejected, ${s.edited} edited, ${s.skipped} skipped, ${stillPending} still pending`,
	);
}
