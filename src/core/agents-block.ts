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

/** "1 and 3", "1, 3 and 5": two numbers or more, the only lists it is given. */
function listLineNumbers(numbers: number[]): string {
	const last = numbers[numbers.length - 1];
	return `${numbers.slice(0, -1).join(", ")} and ${last}`;
}

interface Fence {
	character: string;
	length: number;
	/** How many blockquotes deep the opener stood. */
	depth: number;
}

/**
 * The blockquote markers a line starts with, each up to three spaces in and
 * one space after. It matches at the start of every line (with nothing when
 * the line has no marker), so it needs no `^`: the first match is always there.
 */
const QUOTE_MARKERS = /(?: {0,3}> ?)*/;

/** How many blockquotes deep `line` stands. */
function lineQuoteDepth(line: string): number {
	// Stryker disable next-line OptionalChaining,StringLiteral: QUOTE_MARKERS matches the empty string, so exec never returns null and the default is never read
	return quoteDepth(QUOTE_MARKERS.exec(line)?.[0] ?? "");
}

/** A list item's marker: `-`, `*`, `+`, or a number with `.` or `)`. */
const LIST_MARKER = /[-*+]|\d{1,9}[.)]/g;

/**
 * What stands before a marker: indentation, blockquote `>`s and list item
 * markers (each followed by whitespace), in any order. Like QUOTE_MARKERS,
 * it matches at the start of every line, so it needs no `^`; and a marker's
 * whitespace past the first character is taken by the `[ \t>]` alternative.
 */
function markerPrefix(line: string): string {
	// Stryker disable next-line OptionalChaining,StringLiteral: the pattern matches the empty string, so exec never returns null and the default is never read
	return /(?:[ \t>]|(?:[-*+]|\d{1,9}[.)])[ \t])*/.exec(line)?.[0] ?? "";
}

/**
 * The prefix for the lines after a list item's first: every list marker
 * becomes as many spaces, so the lines continue the same item.
 */
function continuationPrefix(prefix: string): string {
	return prefix.replace(LIST_MARKER, (listMarker) =>
		" ".repeat(listMarker.length),
	);
}

/** How many blockquotes deep a marker with this prefix stands: its `>` count. */
function quoteDepth(prefix: string): number {
	return prefix.replace(/[^>]/g, "").length;
}

/**
 * A code fence opener or closer: three or more backticks or tildes, indented
 * at most three spaces (four is indented code), inside any blockquotes. The
 * rest of the line is the info string, which may hold a line separator or a
 * carriage return; after backticks it may not hold a backtick, since such a
 * line is inline code (CommonMark). A closer is followed only by spaces and
 * tabs; see `closesFence`.
 */
function fenceOf(
	line: string,
): { character: string; length: number; rest: string } | null {
	const unquoted = line.replace(QUOTE_MARKERS, "");
	const match = /^ {0,3}(`{3,}|~{3,})(.*)/s.exec(unquoted);
	if (match === null) return null;
	// Stryker disable next-line StringLiteral: both groups take part in every match, so neither default is ever read
	const [, run = "", rest = ""] = match;
	const character = run.charAt(0);
	if (character === "`" && rest.includes("`")) return null;
	return { character, length: run.length, rest };
}

/**
 * Whether `rest`, what follows a fence run, lets the line close a fence:
 * only spaces and tabs, then the line's own carriage return when it is
 * CRLF. A no-break space, a vertical tab, a form feed or a line separator
 * leaves the fence open, as CommonMark has it.
 */
function closesFence(rest: string): boolean {
	return /^[ \t]*\r?$/.test(rest);
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
		closesFence(found.rest);
	return closes ? null : fence;
}

/**
 * The index of the last line that opens or closes a fence (0 when none
 * does): fences before it are honored, and from it on the text is plain.
 * When that line opens a fence which never closes, CommonMark would call the
 * rest of the file code, but a person never meant that. When it closes one,
 * nothing after it is fenced anyway. A line that ends a quoted fence by its
 * depth and opens another counts as the new fence's opener.
 */
function lastFenceChange(lines: string[]): number {
	let fence: Fence | null = null;
	let changedAt = 0;
	for (const [index, line] of lines.entries()) {
		const next = nextFence(fence, line);
		// nextFence hands back the same fence while it stays open, so a
		// different one means this line opened or closed a fence.
		if (next !== fence) changedAt = index;
		fence = next;
	}
	return changedAt;
}

/**
 * For each line, whether a fence is open after it: its opener, or a line
 * inside it. A closer reads as plain text, which is harmless: like an
 * opener, it can never be a marker, whose text starts with `<`.
 */
function fencedLines(lines: string[]): boolean[] {
	let fence: Fence | null = null;
	return lines.map((line) => {
		fence = nextFence(fence, line);
		return fence !== null;
	});
}

/**
 * The complete start/end pairs in `lines`, in order. A marker out of place
 * (an end with nothing open, a start while another is open, a start left
 * open) is refused by line number:
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
	const fenced = fencedLines(lines.slice(0, lastFenceChange(lines)));
	for (const [index, line] of lines.entries()) {
		if (fenced[index]) continue;
		const prefix = markerPrefix(line);
		const marker = line.slice(prefix.length).trim();
		if (marker === AGENTS_START) {
			if (openAt !== null)
				throw new ForgeError(
					`${file} line ${index + 1} opens an llm-tests-forge block while the one opened on line ${openAt + 1} is still open`,
				);
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
 * indentation, blockquote and list item: its prefix on the first line, and
 * that prefix with list markers turned to spaces on the rest. Pure.
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
	const [only, ...extra] = blocks;
	if (only === undefined) {
		const kept = existing.replace(/(\r?\n)+$/, "");
		return {
			text: `${kept}${ending}${ending}${block.split("\n").join(ending)}${ending}`,
			replaced: false,
		};
	}
	if (extra.length > 0)
		throw new ForgeError(
			`${file} has ${blocks.length} llm-tests-forge blocks (lines ${listLineNumbers(blocks.map((found) => found.startIndex + 1))}); keep one and run init again`,
		);
	// Stryker disable next-line StringLiteral: findBlocks read startIndex from these very lines, so the default is never read
	const startLine = lines[only.startIndex] ?? "";
	const startCarriage = startLine.endsWith("\r") ? "\r" : "";
	// Stryker disable next-line OptionalChaining: findBlocks read endIndex from these very lines, so the line is always there
	const endCarriage = lines[only.endIndex]?.endsWith("\r") ? "\r" : "";
	// A pair indented, in a blockquote or in a list item stays there: the
	// first line takes the start marker's prefix, the rest its continuation.
	const prefix = markerPrefix(startLine);
	const continuation = continuationPrefix(prefix);
	const blockLines = block.split("\n");
	const replacement = blockLines.map(
		(line, position) =>
			(position === 0 ? prefix : continuation) +
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
