import type { Feature } from "../core/schemas";
import { loadTemplate, render } from "../llm/templates";

/** The Python provider promptfoo will call. Written once by `emit`; the person fills in the call to their application. */
export async function shimSource(feature: Feature): Promise<string> {
	const template = await loadTemplate("forge_target", "py");
	return render(template, {
		feature_id: feature.id,
		input_names: `[${feature.inputs.map((i) => JSON.stringify(i.name)).join(", ")}]`,
	});
}
