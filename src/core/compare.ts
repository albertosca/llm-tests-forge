/**
 * Whether two input objects carry the same key/value pairs, regardless of
 * key order -- the shared duplicate check `generateCases` and `importCases`
 * both run against a candidate's input before accepting it.
 */
export function sameInput(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return (
		ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
	);
}
