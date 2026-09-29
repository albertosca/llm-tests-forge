import embeddedPrices from "../../prices.yaml" with { type: "text" };
import { parseYamlText, readYamlFile } from "../core/files";
import { type Prices, PricesSchema } from "../core/schemas";

/** The name errors give the embedded table, which has no path on the disk. */
const EMBEDDED_PRICES = "prices.yaml (embedded)";

export interface ModelPrice {
	input: number;
	output: number;
	/** The table row used; equals `model` when the match was exact. */
	pricedAs: string;
	approximate: boolean;
	/** False when the model's provider has no row at all: `input`/`output` are 0, not a real price. */
	priced: boolean;
}

export async function loadPrices(path?: string): Promise<Prices> {
	if (path === undefined)
		return parseYamlText(EMBEDDED_PRICES, String(embeddedPrices), PricesSchema);
	return readYamlFile(path, PricesSchema);
}

function commonPrefix(first: string, second: string): number {
	let index = 0;
	while (
		index < first.length &&
		index < second.length &&
		first[index] === second[index]
	)
		index += 1;
	return index;
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
	let bestLength = -1;
	for (const [name, price] of Object.entries(prices.models)) {
		if (!name.startsWith(`${provider}/`)) continue;
		const length = commonPrefix(name, model);
		if (length > bestLength) {
			best = name;
			bestPrice = price;
			bestLength = length;
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
