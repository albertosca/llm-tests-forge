import type { Case } from "./schemas";

export function slugify(text: string): string {
	// Every run of other characters becomes one dash, so no two dashes are ever
	// adjacent: trimming one dash from an end trims them all.
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
}

export function nextCaseId(scenarioId: string, existing: Case[]): string {
	const prefix = `${scenarioId}-`;
	let highest = 0;
	for (const existingCase of existing) {
		if (!existingCase.id.startsWith(prefix)) continue;
		const suffix = Number.parseInt(existingCase.id.slice(prefix.length), 10);
		if (Number.isFinite(suffix)) highest = Math.max(highest, suffix);
	}
	return `${prefix}${String(highest + 1).padStart(2, "0")}`;
}
