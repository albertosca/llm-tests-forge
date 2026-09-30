/**
 * Whether two input objects carry the same key/value pairs, regardless of
 * key order -- the shared duplicate check `generateCases` and `importCases`
 * both run against a candidate's input before accepting it.
 *
 * Equal key counts plus every left value found, equal, under the same key
 * on the right means the key sets are equal too: every value is a string,
 * so a key the right side lacks reads as `undefined` and never matches.
 * Comparing sorted key lists as well would check the same thing twice.
 */
export function sameInput(
	left: Record<string, string>,
	right: Record<string, string>,
): boolean {
	const leftKeys = Object.keys(left);
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}
