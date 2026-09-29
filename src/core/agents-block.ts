import { ForgeError } from "./errors";

export const AGENTS_START = "<!-- llm-tests-forge:start -->";
export const AGENTS_END = "<!-- llm-tests-forge:end -->";

export function agentsBlock(): string {
	return [
		AGENTS_START,
		"This project keeps LLM regression suites made with llm-tests-forge.",
		"Run `llm-tests-forge status` to see which suites exist and what is pending.",
		"Run `llm-tests-forge guide` before creating or changing a suite: it is the manual, and approving is the person's job.",
		AGENTS_END,
	].join("\n");
}

interface MarkedBlock {
	startIndex: number;
	endIndex: number;
}

/** "1", "1 and 3", "1, 3 and 5". */
function listLineNumbers(numbers: number[]): string {
	if (numbers.length === 1) return `${numbers[0]}`;
	const last = numbers[numbers.length - 1];
	return `${numbers.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * The complete start/end pairs in `lines`, in order. A marker out of place
 * (an end with nothing open, a start left open) is refused by line number:
 * guessing which half was meant would rewrite text the person wrote.
 */
function findBlocks(file: string, lines: string[]): MarkedBlock[] {
	const blocks: MarkedBlock[] = [];
	let openAt: number | null = null;
	for (const [index, line] of lines.entries()) {
		const marker = line.trim();
		if (marker === AGENTS_START) {
			if (openAt !== null) break;
			openAt = index;
		} else if (marker === AGENTS_END) {
			if (openAt === null)
				throw new ForgeError(
					`${file} line ${index + 1} closes an llm-tests-forge block that was never opened`,
				);
			blocks.push({ startIndex: openAt, endIndex: index });
			openAt = null;
		}
	}
	if (openAt !== null)
		throw new ForgeError(
			`${file} line ${openAt + 1} opens the llm-tests-forge block and nothing closes it`,
		);
	return blocks;
}

/**
 * The AGENTS.md text with the llm-tests-forge block in it: created when the
 * file is missing, appended after a blank line when it has no block,
 * replaced in place when it has exactly one. Pure.
 */
export function upsertAgentsBlock(
	file: string,
	existing: string | null,
): string {
	const block = agentsBlock();
	if (existing === null || existing.trim() === "") return `${block}\n`;
	const lines = existing.split("\n");
	const blocks = findBlocks(file, lines);
	if (blocks.length === 0)
		return `${existing.replace(/\n+$/, "")}\n\n${block}\n`;
	const [only, ...extra] = blocks;
	if (only === undefined || extra.length > 0)
		throw new ForgeError(
			`${file} has ${blocks.length} llm-tests-forge blocks (lines ${listLineNumbers(blocks.map((found) => found.startIndex + 1))}); keep one and run init again`,
		);
	return [
		...lines.slice(0, only.startIndex),
		block,
		...lines.slice(only.endIndex + 1),
	].join("\n");
}
