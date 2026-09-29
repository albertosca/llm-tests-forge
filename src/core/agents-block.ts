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

interface Fence {
	character: string;
	length: number;
}

/** A code fence opener or closer: three or more backticks or tildes, indented at most three spaces (four is indented code). */
function fenceOf(
	line: string,
): { character: string; length: number; rest: string } | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""));
	const run = match?.[1];
	if (match === null || run === undefined) return null;
	return { character: run.charAt(0), length: run.length, rest: match[2] ?? "" };
}

/** The fence state after `line`: opened, closed, or unchanged. */
function nextFence(fence: Fence | null, line: string): Fence | null {
	const found = fenceOf(line);
	if (found === null) return fence;
	if (fence === null)
		return { character: found.character, length: found.length };
	const closes =
		found.character === fence.character &&
		found.length >= fence.length &&
		found.rest.trim() === "";
	return closes ? null : fence;
}

/** True when a fence opens and never closes: CommonMark would call the rest of the file code, but a person never meant that. */
function endsInsideFence(lines: string[]): boolean {
	let fence: Fence | null = null;
	for (const line of lines) fence = nextFence(fence, line);
	return fence !== null;
}

/**
 * The complete start/end pairs in `lines`, in order. A marker out of place
 * (an end with nothing open, a start left open) is refused by line number:
 * guessing which half was meant would rewrite text the person wrote. A
 * marker inside a closed fenced code block is quoted text, not the block; a
 * fence still open at the end of the file is not a fence, so nothing is
 * skipped.
 */
function findBlocks(file: string, lines: string[]): MarkedBlock[] {
	const blocks: MarkedBlock[] = [];
	let openAt: number | null = null;
	let fence: Fence | null = null;
	const honorFences = !endsInsideFence(lines);
	for (const [index, line] of lines.entries()) {
		if (honorFences) {
			const before = fence;
			fence = nextFence(fence, line);
			if (before !== null || fence !== null) continue;
		}
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
 * replaced in place when it has exactly one. `replaced` says whether a real
 * marker pair was found. The file's own line endings (LF or CRLF) are kept,
 * in the block too. Pure.
 */
export function planAgentsBlock(
	file: string,
	existing: string | null,
): { text: string; replaced: boolean } {
	const block = agentsBlock();
	if (existing === null || existing.trim() === "")
		return { text: `${block}\n`, replaced: false };
	const lines = existing.split("\n");
	const blocks = findBlocks(file, lines);
	if (blocks.length === 0) {
		const lastBreak = existing.lastIndexOf("\n");
		const ending = existing.charAt(lastBreak - 1) === "\r" ? "\r\n" : "\n";
		const kept = existing.replace(/(\r?\n)+$/, "");
		return {
			text: `${kept}${ending}${ending}${block.split("\n").join(ending)}${ending}`,
			replaced: false,
		};
	}
	const [only, ...extra] = blocks;
	if (only === undefined || extra.length > 0)
		throw new ForgeError(
			`${file} has ${blocks.length} llm-tests-forge blocks (lines ${listLineNumbers(blocks.map((found) => found.startIndex + 1))}); keep one and run init again`,
		);
	const startCarriage = lines[only.startIndex]?.endsWith("\r") ? "\r" : "";
	const endCarriage = lines[only.endIndex]?.endsWith("\r") ? "\r" : "";
	const blockLines = block.split("\n");
	const replacement = blockLines.map(
		(line, position) =>
			line + (position < blockLines.length - 1 ? startCarriage : endCarriage),
	);
	return {
		text: [
			...lines.slice(0, only.startIndex),
			...replacement,
			...lines.slice(only.endIndex + 1),
		].join("\n"),
		replaced: true,
	};
}

/** The AGENTS.md text with the block in it; see `planAgentsBlock`. */
export function upsertAgentsBlock(
	file: string,
	existing: string | null,
): string {
	return planAgentsBlock(file, existing).text;
}
