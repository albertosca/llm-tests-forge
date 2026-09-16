import type { Case } from "./schemas";

export function slugify(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

export function nextCaseId(scenarioId: string, existing: Case[]): string {
	const prefix = `${scenarioId}-`;
	let max = 0;
	for (const c of existing) {
		if (!c.id.startsWith(prefix)) continue;
		const n = Number.parseInt(c.id.slice(prefix.length), 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return `${prefix}${String(max + 1).padStart(2, "0")}`;
}
