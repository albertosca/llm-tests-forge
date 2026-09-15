import { stringify } from "yaml";
import { z } from "zod";
import type { Llm } from "../llm/generate";
import { loadTemplate, render } from "../llm/templates";
import { ForgeError } from "./errors";
import { slugify } from "./ids";
import { type Feature, Kind, type Scenario, ScenarioSchema } from "./schemas";

const DEFAULT_COUNT = 12;

export const ScenariosOutputSchema = z.object({
	scenarios: z.array(ScenarioSchema.omit({ status: true })),
});

export interface EnumerateScenariosArgs {
	feature: Feature;
	existing: Scenario[];
	kinds?: Kind[];
	more?: number;
	model: string;
	llm: Llm;
}

function uniqueId(base: string, taken: Set<string>): string {
	let id = base;
	let n = 2;
	while (taken.has(id)) {
		id = `${base}-${n}`;
		n += 1;
	}
	taken.add(id);
	return id;
}

export async function enumerateScenarios(
	args: EnumerateScenariosArgs,
): Promise<Scenario[]> {
	const wantedKinds = args.kinds ?? [...Kind.options];
	const count = args.more ?? DEFAULT_COUNT;
	const coverage =
		args.more === undefined
			? `, with at least one of each kind: ${wantedKinds.join(", ")}`
			: "";
	const template = await loadTemplate("scenarios");
	const prompt = render(template, {
		feature: stringify(args.feature, { lineWidth: 0 }),
		count: String(count),
		coverage,
		existing:
			args.existing.length > 0
				? stringify(
						args.existing.map((s) => ({
							id: s.id,
							kind: s.kind,
							description: s.description,
						})),
						{ lineWidth: 0 },
					)
				: "(none)",
	});
	const { object } = await args.llm.generate({
		schema: ScenariosOutputSchema,
		prompt,
		model: args.model,
		verb: "scenarios",
	});
	if (object.scenarios.length === 0)
		throw new ForgeError("the model returned zero scenarios", {
			id: args.feature.id,
		});

	if (args.more === undefined) {
		const present = new Set(object.scenarios.map((s) => s.kind));
		const missing = wantedKinds.filter((k) => !present.has(k));
		if (missing.length > 0)
			throw new ForgeError(
				`generated scenarios miss these kinds: ${missing.join(", ")}; rerun, or restrict with --kinds`,
				{ id: args.feature.id },
			);
	}

	const taken = new Set(args.existing.map((s) => s.id));
	const fresh: Scenario[] = object.scenarios.map((s) => ({
		...s,
		id: uniqueId(slugify(s.id) || "scenario", taken),
		status: "pending",
	}));
	return [...args.existing, ...fresh];
}
