import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ForgeError } from "../core/errors";

const TEMPLATES_DIR = fileURLToPath(
	new URL("../../templates/", import.meta.url),
);

export async function loadTemplate(name: string): Promise<string> {
	const path = `${TEMPLATES_DIR}${name}.md`;
	return readFile(path, "utf8").catch(() => {
		throw new ForgeError("template not found", { file: path });
	});
}

export function render(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const value = vars[key];
		if (value === undefined)
			throw new ForgeError(`template placeholder "{{${key}}}" has no value`);
		return value;
	});
}
