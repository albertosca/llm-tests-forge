import casesTemplate from "../../templates/cases.md" with { type: "text" };
import dedupeTemplate from "../../templates/dedupe.md" with { type: "text" };
import describeTemplate from "../../templates/describe.md" with {
	type: "text",
};
import scenariosTemplate from "../../templates/scenarios.md" with {
	type: "text",
};
import pythonShim from "../../templates/shims/python.py.tmpl" with {
	type: "text",
};
import { ForgeError } from "../core/errors";

/**
 * Every template the forge renders, embedded at build time: a path read
 * from the disk at run time would point inside the build machine's
 * checkout, which a compiled binary does not carry.
 */
const TEMPLATES: Record<string, string> = {
	cases: casesTemplate,
	dedupe: dedupeTemplate,
	describe: describeTemplate,
	scenarios: scenariosTemplate,
	"shims/python": pythonShim,
};

export function loadTemplate(name: string): string {
	const template = TEMPLATES[name];
	if (template === undefined)
		throw new ForgeError("template not found", { id: name });
	return template;
}

export function render(
	template: string,
	variables: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const value = variables[key];
		if (value === undefined)
			throw new ForgeError(`template placeholder "{{${key}}}" has no value`);
		return value;
	});
}
