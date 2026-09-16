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
	/** False when the model's provider has no row at all: `input`/`output` are 0, not a real price. */
	priced: boolean;
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
 * Exact row, else the same-provider row sharing the longest prefix, else not
 * priced at all: a provider with no row in the table (a local model, a new
 * provider the table hasn't caught up with) has no basis for a guess, so it
 * is priced at 0 and marked `priced: false` rather than borrowing another
 * provider's rate — the caller prints which row was used, and a guess the
 * person cannot see is worse than no estimate.
 */
export function priceFor(model: string, prices: Prices): ModelPrice {
	const exact = prices.models[model];
	if (exact)
		return { ...exact, pricedAs: model, approximate: false, priced: true };
	const provider = model.split("/")[0] ?? "";
	let best: string | undefined;
	let bestPrice: Prices["models"][string] | undefined;
	let bestLen = -1;
	for (const [name, price] of Object.entries(prices.models)) {
		if (!name.startsWith(`${provider}/`)) continue;
		const len = commonPrefix(name, model);
		if (len > bestLen) {
			best = name;
			bestPrice = price;
			bestLen = len;
		}
	}
	if (best === undefined || bestPrice === undefined)
		return {
			input: 0,
			output: 0,
			pricedAs: model,
			approximate: true,
			priced: false,
		};
	return { ...bestPrice, pricedAs: best, approximate: true, priced: true };
}
