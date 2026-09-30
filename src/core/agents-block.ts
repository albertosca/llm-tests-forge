import { ForgeError } from "./errors";

export const AGENTS_START = "<!-- llm-tests-forge:start -->";
export const AGENTS_END = "<!-- llm-tests-forge:end -->";

/** How the command is called when it is a project dependency rather than on the PATH; the guide and the plugin skill say the same. */
export const PER_PROJECT_INVOCATIONS =
	"Installed as a project dependency, call it as `npx llm-tests-forge`, `uv run llm-tests-forge`, `bundle exec llm-tests-forge`, or `_build/llm-tests-forge` under Elixir.";

export function agentsBlock(): string {
	return [
		AGENTS_START,
		"This project keeps LLM regression suites made with llm-tests-forge.",
		"Run `llm-tests-forge status` to see which suites exist and what is pending.",
		"Run `llm-tests-forge guide` before creating or changing a suite: it is the manual, and approving is the person's job.",
		PER_PROJECT_INVOCATIONS,
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
	/** How many blockquotes deep the opener stood. */
	depth: number;
}

/** The blockquote markers a line starts with, each up to three spaces in and one space after. */
const QUOTE_MARKERS = /^(?: {0,3}> ?)*/;

/** How many blockquotes deep `line` stands. */
function lineQuoteDepth(line: string): number {
	return quoteDepth(QUOTE_MARKERS.exec(line)?.[0] ?? "");
}

/** The spaces, tabs and `>` before a marker: its indentation and blockquote prefix. */
function markerPrefix(line: string): string {
	return /^[ \t>]*/.exec(line)?.[0] ?? "";
}

/** How many blockquotes deep a marker with this prefix stands. */
function quoteDepth(prefix: string): number {
	return prefix.split(">").length - 1;
}

/**
 * A code fence opener or closer: three or more backticks or tildes, indented
 * at most three spaces (four is indented code), inside any blockquotes.
 */
function fenceOf(
	line: string,
): { character: string; length: number; rest: string } | null {
	const unquoted = line.replace(/\r$/, "").replace(QUOTE_MARKERS, "");
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(unquoted);
	const run = match?.[1];
	if (match === null || run === undefined) return null;
	return { character: run.charAt(0), length: run.length, rest: match[2] ?? "" };
}

/**
 * The fence still open when `line` begins: a line fewer blockquotes deep
 * than the fence's opener (a blank line, or text outside the quote) ends
 * the blockquote and the fence in it, as CommonMark has it.
 */
function fenceBefore(fence: Fence | null, line: string): Fence | null {
	return fence !== null && lineQuoteDepth(line) < fence.depth ? null : fence;
}

/**
 * The fence state after `line`: opened, closed, or unchanged. A line that
 * ends a fence by its depth is then read as a possible opener itself.
 */
function nextFence(open: Fence | null, line: string): Fence | null {
	const fence = fenceBefore(open, line);
	const found = fenceOf(line);
	if (found === null) return fence;
	if (fence === null)
		return {
			character: found.character,
			length: found.length,
			depth: lineQuoteDepth(line),
		};
	const closes =
		found.character === fence.character &&
		found.length >= fence.length &&
		found.rest.trim() === "";
	return closes ? null : fence;
}

/**
 * The index of the line that opens a fence which never closes, or null when
 * every fence closes. CommonMark would call the rest of the file code, but a
 * person never meant that: from this line on, the text is plain.
 */
function unclosedFenceStart(lines: string[]): number | null {
	let fence: Fence | null = null;
	let openedAt = 0;
	for (const [index, line] of lines.entries()) {
		const next = nextFence(fence, line);
		if (fence === null && next !== null) openedAt = index;
		fence = next;
	}
	return fence === null ? null : openedAt;
}

/**
 * The complete start/end pairs in `lines`, in order. A marker out of place
 * (an end with nothing open, a start left open) is refused by line number:
 * guessing which half was meant would rewrite text the person wrote. A
 * marker inside a closed fenced code block is quoted text, not the block; the
 * fence still open at the end of the file is not a fence, so from its opener
 * on nothing is skipped (the fences that did close still protect what they
 * quote).
 */
function findBlocks(file: string, lines: string[]): MarkedBlock[] {
	const blocks: MarkedBlock[] = [];
	let openAt: number | null = null;
	let openDepth = 0;
	let fence: Fence | null = null;
	const honorFencesBefore = unclosedFenceStart(lines) ?? lines.length;
	for (const [index, line] of lines.entries()) {
		if (index < honorFencesBefore) {
			const before = fenceBefore(fence, line);
			fence = nextFence(fence, line);
			if (before !== null || fence !== null) continue;
		}
		const prefix = markerPrefix(line);
		const marker = line.slice(prefix.length).trim();
		if (marker === AGENTS_START) {
			if (openAt !== null) break;
			openAt = index;
			openDepth = quoteDepth(prefix);
		} else if (marker === AGENTS_END) {
			if (openAt === null)
				throw new ForgeError(
					`${file} line ${index + 1} closes an llm-tests-forge block that was never opened`,
				);
			if (quoteDepth(prefix) !== openDepth)
				throw new ForgeError(
					`${file} line ${index + 1} closes the llm-tests-forge block opened on line ${openAt + 1} at a different blockquote depth`,
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
 * in the block too, and a replaced block keeps the start marker's
 * indentation and blockquote prefix on every line. Pure.
 */
export function planAgentsBlock(
	file: string,
	existing: string | null,
): { text: string; replaced: boolean } {
	const block = agentsBlock();
	if (existing === null) return { text: `${block}\n`, replaced: false };
	// The ending of the last line break; LF when there is none.
	const lastBreak = existing.lastIndexOf("\n");
	const ending = existing.charAt(lastBreak - 1) === "\r" ? "\r\n" : "\n";
	if (existing.trim() === "")
		return {
			text: `${block.split("\n").join(ending)}${ending}`,
			replaced: false,
		};
	const lines = existing.split("\n");
	const blocks = findBlocks(file, lines);
	if (blocks.length === 0) {
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
	const startLine = lines[only.startIndex] ?? "";
	const startCarriage = startLine.endsWith("\r") ? "\r" : "";
	const endCarriage = lines[only.endIndex]?.endsWith("\r") ? "\r" : "";
	// A pair under a list item, in indented code or in a blockquote stays
	// there: every line of the block takes the start marker's prefix.
	const prefix = markerPrefix(startLine);
	const blockLines = block.split("\n");
	const replacement = blockLines.map(
		(line, position) =>
			prefix +
			line +
			(position < blockLines.length - 1 ? startCarriage : endCarriage),
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
