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
	let suffix = 2;
	while (taken.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}
	taken.add(id);
	return id;
}

export async function enumerateScenarios(
	request: EnumerateScenariosArgs,
): Promise<Scenario[]> {
	const wantedKinds = request.kinds ?? [...Kind.options];
	const count = request.more ?? DEFAULT_COUNT;
	const coverage =
		request.more === undefined
			? `, with at least one of each kind: ${wantedKinds.join(", ")}`
			: "";
	const template = loadTemplate("scenarios");
	const prompt = render(template, {
		feature: stringify(request.feature, { lineWidth: 0 }),
		count: String(count),
		coverage,
		existing:
			request.existing.length > 0
				? stringify(
						request.existing.map((scenario) => ({
							id: scenario.id,
							kind: scenario.kind,
							description: scenario.description,
						})),
						{ lineWidth: 0 },
					)
				: "(none)",
	});
	const { object } = await request.llm.generate({
		schema: ScenariosOutputSchema,
		prompt,
		model: request.model,
		verb: "scenarios",
	});
	if (object.scenarios.length === 0)
		throw new ForgeError("the model returned zero scenarios", {
			id: request.feature.id,
		});

	if (request.more === undefined) {
		const present = new Set(object.scenarios.map((scenario) => scenario.kind));
		const missing = wantedKinds.filter((kind) => !present.has(kind));
		if (missing.length > 0)
			throw new ForgeError(
				`generated scenarios miss these kinds: ${missing.join(", ")}; rerun, or restrict with --kinds`,
				{ id: request.feature.id },
			);
	}

	const taken = new Set(request.existing.map((scenario) => scenario.id));
	const fresh: Scenario[] = object.scenarios.map((scenario) => ({
		...scenario,
		id: uniqueId(slugify(scenario.id) || "scenario", taken),
		status: "pending",
	}));
	return [...request.existing, ...fresh];
}
