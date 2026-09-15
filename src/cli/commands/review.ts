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
import { applyDecision, pendingItems } from "../../core/review";
import type { Case, Feature, Oracle, Scenario } from "../../core/schemas";
import type { CliContext } from "../context";
import { askChoice, askExpectedFor, openInEditor } from "../prompts";
import { runReviewLoop } from "../review-loop";

const ONLY_VALUES = ["feature", "scenarios", "cases"];

function parseOnlyFlag(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	if (!ONLY_VALUES.includes(raw))
		throw new ForgeError(
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
	if (values.scenario && !scenarios.some((s) => s.id === values.scenario))
		throw new ForgeError(`scenario "${values.scenario}" not found`, {
			id: values.scenario,
		});

	if (values.all) {
		const id = values.scenario;
		if (!id) throw new UsageError("--all requires --scenario");
		const cases = await readCases(ctx.forgeDir, id);
		let approved = 0;
		let skipped = 0;
		const updated = cases.map((c) => {
			if (c.status !== "pending") return c;
			if (c.expected === undefined) {
				skipped += 1;
				return c;
			}
			approved += 1;
			return applyDecision(c, "approve");
		});
		if (approved > 0) await writeCases(ctx.forgeDir, id, updated);
		ctx.stdout(
			skipped > 0
				? `review: approved ${approved} pending case(s) of ${id}; ${skipped} left pending (no expected set — run \`forge review --scenario ${id}\` to fill them in)`
				: `review: approved ${approved} pending case(s) of ${id}`,
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
		askExpected: (c, oracle) => askExpectedFor(c, oracle, io),
		oracleOf,
		print: ctx.stdout,
	});

	// Every decision is matched back to the file by the id the item had
	// when this pass started (`originalId`), never by the id it carries
	// now: an edit is allowed to change the id, and matching on the new one
	// found nothing, wrote nothing, and still reported the edit as applied.
	// Each list is rebuilt from what was read off disk, so a decision that
	// matched nothing cannot invent a file to land in either.
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
			scenarios.map((s) => decidedScenarios.get(s.id) ?? s),
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
			list.map((c) => decidedCases.get(c.id) ?? c),
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
