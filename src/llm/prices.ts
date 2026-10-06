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

/**
 * The table at `path`, or the one embedded in the binary. `embeddedText` is
 * the embedded table's text: a seam for the test that gives it a table that
 * does not parse, which the real one never is.
 */
export async function loadPrices(
	path?: string,
	embeddedText: string = String(embeddedPrices),
): Promise<Prices> {
	if (path === undefined)
		return parseYamlText(EMBEDDED_PRICES, embeddedText, PricesSchema);
	return readYamlFile(path, PricesSchema);
}

/**
 * How many characters the two strings share from the start. Past the end of
 * either, `charCodeAt` is NaN, and NaN equals nothing, not even itself: the
 * loop needs no bound of its own and ends at the shorter string.
 */
function commonPrefix(first: string, second: string): number {
	let length = 0;
	while (first.charCodeAt(length) === second.charCodeAt(length)) length += 1;
	return length;
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
	// Own keys only: `constructor` or `toString` is not a row. Every row of a
	// table that passed PricesSchema holds a price, so a row is never undefined
	// here or in the loop below; no guard for that is needed.
	const exact = Object.hasOwn(prices.models, model)
		? prices.models[model]
		: undefined;
	if (exact)
		return { ...exact, pricedAs: model, approximate: false, priced: true };
	const slash = model.indexOf("/");
	const provider = slash === -1 ? model : model.slice(0, slash);
	let best:
		| { name: string; price: Prices["models"][string]; length: number }
		| undefined;
	for (const [name, price] of Object.entries(prices.models)) {
		if (!name.startsWith(`${provider}/`)) continue;
		const length = commonPrefix(name, model);
		if (best === undefined || length > best.length)
			best = { name, price, length };
	}
	if (best === undefined)
		return {
			input: 0,
			output: 0,
			pricedAs: model,
			approximate: true,
			priced: false,
		};
	return {
		...best.price,
		pricedAs: best.name,
		approximate: true,
		priced: true,
	};
}
