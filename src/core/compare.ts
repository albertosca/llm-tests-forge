/**
 * Whether two input objects carry the same key/value pairs, regardless of
 * key order -- the shared duplicate check `generateCases` and `importCases`
 * both run against a candidate's input before accepting it.
 *
 * Equal key counts plus every left value found, equal, under the same key
 * on the right means the key sets are equal too: every value is a string
 * (CaseSchema and the import's own check refuse anything else; pinned in
 * tests/core/compare.test.ts), so a key the right side lacks reads as a
 * non-string — `undefined`, or a function for a key such as `constructor`
 * that names an Object.prototype member — and never matches. Comparing
 * sorted key lists as well would check the same thing twice.
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
