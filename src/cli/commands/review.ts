import { parseArgs } from "node:util";
import { ForgeError } from "../../core/errors";
import {
	listCaseScenarios,
	readCases,
	readFeature,
	readScenarios,
	writeCases,
	writeFeature,
	writeScenarios,
} from "../../core/files";
import { pendingItems } from "../../core/review";
import type { Case, Feature, Oracle, Scenario } from "../../core/schemas";
import type { CliContext } from "../context";
import { askChoice, askExpectedFor, openInEditor } from "../prompts";
import { runReviewLoop } from "../review-loop";

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

	if (values.all) {
		const id = values.scenario;
		if (!id)
			throw new ForgeError("--all requires --scenario", { file: "usage" });
		const cases = await readCases(ctx.forgeDir, id);
		const updated = cases.map((c) =>
			c.status === "pending" ? { ...c, status: "approved" as const } : c,
		);
		await writeCases(ctx.forgeDir, id, updated);
		ctx.stdout(`review: approved every pending case of ${id}`);
		return;
	}

	const feature = await readFeature(ctx.forgeDir);
	const scenarios = await readScenarios(ctx.forgeDir);
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
	let items = pendingItems(feature, scopedScenarios, allCases);
	if (values.only) {
		const only = values.only;
		items = items.filter((i) => i.kind === only || `${i.kind}s` === only);
	}
	if (items.length === 0) {
		ctx.stdout("review: nothing pending");
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

	for (const d of result.decisions) {
		if (d.kind === "feature")
			await writeFeature(ctx.forgeDir, d.item as Feature);
		if (d.kind === "scenario") {
			const idx = scenarios.findIndex((s) => s.id === d.id);
			if (idx >= 0) scenarios[idx] = d.item as Scenario;
		}
		if (d.kind === "case") {
			const c = d.item as Case;
			const list = casesById.get(c.scenario) ?? [];
			const idx = list.findIndex((x) => x.id === c.id);
			if (idx >= 0) list[idx] = c;
			casesById.set(c.scenario, list);
		}
	}
	if (result.decisions.some((d) => d.kind === "scenario"))
		await writeScenarios(ctx.forgeDir, scenarios);
	for (const [id, list] of casesById) {
		if (
			result.decisions.some(
				(d) => d.kind === "case" && (d.item as Case).scenario === id,
			)
		)
			await writeCases(ctx.forgeDir, id, list);
	}
	const s = result.summary;
	ctx.stdout(
		`review: ${s.approved} approved, ${s.rejected} rejected, ${s.edited} edited, ${s.skipped} skipped`,
	);
}
