/** `1 case`, `2 cases`: the count and an English noun, pluralised with a trailing "s". */
export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}
