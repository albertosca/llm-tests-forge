import { fileURLToPath } from "node:url";
import { readYamlFile } from "../core/files";
import { type Prices, PricesSchema } from "../core/schemas";

export const PRICES_PATH = fileURLToPath(
	new URL("../../prices.yaml", import.meta.url),
);

export interface ModelPrice {
	input: number;
	output: number;
	/** The table row used; equals `model` when the match was exact. */
	pricedAs: string;
	approximate: boolean;
}

export async function loadPrices(path: string = PRICES_PATH): Promise<Prices> {
	return readYamlFile(path, PricesSchema);
}

function commonPrefix(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
	return i;
}

/**
 * Exact row, else the same-provider row sharing the longest prefix, else the
 * first row of the table. Everything but the exact match is `approximate`,
 * and the caller prints which row was used — a guess the person cannot see
 * is worse than no estimate.
 */
export function priceFor(model: string, prices: Prices): ModelPrice {
	const exact = prices.models[model];
	if (exact) return { ...exact, pricedAs: model, approximate: false };
	const provider = model.split("/")[0] ?? "";
	const names = Object.keys(prices.models);
	let best: string | undefined;
	let bestLen = -1;
	for (const name of names) {
		if (!name.startsWith(`${provider}/`)) continue;
		const len = commonPrefix(name, model);
		if (len > bestLen) {
			best = name;
			bestLen = len;
		}
	}
	const row = best ?? names[0];
	// PricesSchema refines `models` to be non-empty, so `names[0]` exists;
	// the fallback below only satisfies noUncheckedIndexedAccess.
	const chosen = row ?? model;
	const price = prices.models[chosen] ?? { input: 0, output: 0 };
	return { ...price, pricedAs: chosen, approximate: true };
}
