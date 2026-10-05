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
	/** The content column of the list item the opener stood in; 0 outside any. */
	column: number;
}

/**
 * The blockquote markers a line starts with, each up to three spaces in and
 * one space after. It matches at the start of every line (with nothing when
 * the line has no marker), so it needs no `^`: the first match is always there.
 */
const QUOTE_MARKERS = /(?: {0,3}> ?)*/;

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
 * A code fence opener or closer in `text`, a line from its container's
 * content column on (past its blockquotes and list items): three or more
 * backticks or tildes, indented at most three spaces (four is indented
 * code). The rest of the line is the info string, which may hold a line
 * separator or a carriage return; after backticks it may not hold a
 * backtick, since such a line is inline code (CommonMark). A closer is
 * followed only by spaces and tabs; see `closesFence`.
 */
function fenceOf(
	text: string,
): { character: string; length: number; rest: string } | null {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)/s.exec(text);
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

/** `text` with each tab turned into spaces up to the next multiple of four columns, as CommonMark measures indentation. */
function expandTabs(text: string): string {
	let expanded = "";
	for (const character of text)
		expanded +=
			character === "\t" ? " ".repeat(4 - (expanded.length % 4)) : character;
	return expanded;
}

/** How many columns of spaces `text` (its tabs expanded) starts with. */
function indentOf(text: string): number {
	return text.length - text.replace(/^ +/, "").length;
}

/** Whether `text` holds only spaces, then the line's own carriage return when it is CRLF. */
function isBlank(text: string): boolean {
	return /^ *\r?$/.test(text);
}

/**
 * `expanded` past its first `count` blockquote markers. Called only with a
 * `count` no greater than the markers the line starts with.
 */
function pastQuotes(expanded: string, count: number): string {
	let rest = expanded;
	for (let level = 0; level < count; level += 1)
		// Stryker disable next-line Regex: the line starts with at least `count` markers, so the leftmost match is always at the start and dropping the anchor strips the same text
		rest = rest.replace(/^ {0,3}> ?/, "");
	return rest;
}

/**
 * The content columns of the list items `body` opens from `column` on,
 * outermost first (`- - x` opens two). A marker stands up to three spaces
 * in and is followed by a space or the end of the line. Its content starts
 * after the one to four spaces that follow it; after five or more
 * (indented code in the item) or none (an empty item), one column past it.
 */
function itemColumns(body: string, column: number): number[] {
	const match = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))(?= |\r?$)( *)/.exec(
		body.slice(column),
	);
	if (match === null) return [];
	// Stryker disable next-line StringLiteral: both groups take part in every match, so neither default is ever read
	const [, marker = "", spaces = ""] = match;
	const markerEnd = column + marker.length;
	const content =
		spaces.length <= 4 && !isBlank(body.slice(markerEnd))
			? markerEnd + spaces.length
			: markerEnd + 1;
	return [content, ...itemColumns(body, content)];
}

/** What the scan knows as a line begins. */
interface Scan {
	fence: Fence | null;
	/** How many blockquotes deep the line before stood. */
	depth: number;
	/** The content columns of the list items open at that depth, outermost first. */
	items: number[];
	/**
	 * Whether a line four columns or more past its container's content is
	 * indented code: at the start of the file, after a blank line or a
	 * fence, or right after indented code. After a paragraph's line it
	 * continues the paragraph instead.
	 */
	codeMayStart: boolean;
}

const FILE_START: Scan = {
	fence: null,
	depth: 0,
	// Stryker disable next-line ArrayDeclaration: a line that is not blank keeps only the columns at or left of its indentation, which a string never is, and a blank line reads no column, so what the list starts with is never read
	items: [],
	codeMayStart: true,
};

/**
 * What the scan knows after `line`, and whether the line is quoted (a
 * fence's opener, closer or content, or indented code), so that it cannot
 * be a marker. Blockquotes count by depth; list items by their content
 * columns, which indentation, fences and indented code are measured from,
 * as CommonMark has it:
 * - a line fewer blockquotes deep than a fence's opener, or one with text
 *   left of the content column of the item the opener stood in (a `>`
 *   included), ends that container and the fence in it, and is then read
 *   afresh: it may open a fence itself;
 * - a closer stands at the opener's very depth: inside the fence, a deeper
 *   line starts with `>`, so it is content;
 * - `mayOpen` false reads an opener as text (see `quotedLines`).
 * Tabs count from the line's start, so `>` and a tab leave two columns of
 * indentation. A line at another blockquote depth closes every list item;
 * a blank line keeps them open, and lazy continuation lines are not
 * followed. Opener, closer and blank lines can never be a marker (its text
 * starts with `<`), so whether they count as quoted changes nothing.
 */
function readLine(
	scan: Scan,
	line: string,
	mayOpen: boolean,
): { scan: Scan; quoted: boolean } {
	const expanded = expandTabs(line);
	// Stryker disable next-line OptionalChaining,StringLiteral: QUOTE_MARKERS matches the empty string, so exec never returns null and the default is never read
	const quotes = QUOTE_MARKERS.exec(expanded)?.[0] ?? "";
	const depth = quoteDepth(quotes);
	const body = expanded.slice(quotes.length);
	const blank = isBlank(body);
	const indent = indentOf(body);
	const fence = scan.fence;
	if (fence !== null && depth >= fence.depth) {
		// The line inside the blockquotes the fence stands in.
		const inner = pastQuotes(expanded, fence.depth);
		if (isBlank(inner) || indentOf(inner) >= fence.column) {
			const found = fenceOf(inner.slice(fence.column));
			const closes =
				found !== null &&
				found.character === fence.character &&
				found.length >= fence.length &&
				closesFence(found.rest);
			return {
				scan: { ...scan, fence: closes ? null : fence, codeMayStart: true },
				quoted: true,
			};
		}
	}
	const kept = scan.items.filter(
		(column) => depth === scan.depth && (blank || column <= indent),
	);
	if (blank)
		return {
			scan: { fence: null, depth, items: kept, codeMayStart: true },
			// Stryker disable next-line BooleanLiteral: a blank line is never a marker either way
			quoted: false,
		};
	const column = kept.at(-1) ?? 0;
	if (indent - column >= 4)
		return {
			scan: {
				fence: null,
				depth,
				items: kept,
				codeMayStart: scan.codeMayStart,
			},
			quoted: scan.codeMayStart,
		};
	const opened = [...kept, ...itemColumns(body, column)];
	const content = opened.at(-1) ?? 0;
	const found = mayOpen ? fenceOf(body.slice(content)) : null;
	const opener =
		found === null
			? null
			: {
					character: found.character,
					length: found.length,
					depth,
					column: content,
				};
	return {
		scan: { fence: opener, depth, items: opened, codeMayStart: false },
		quoted: false,
	};
}

/**
 * For each line, whether it is quoted (see `readLine`). Fences are honored
 * up to the last line that opens or closes one, and from it on no fence
 * opens. When that line opens a fence which never closes, CommonMark would
 * call the rest of the file code, but a person never meant that; when it
 * closes one, nothing after it is fenced anyway. A line that ends a fence
 * by its container and opens another counts as the new fence's opener.
 */
function quotedLines(lines: string[]): boolean[] {
	let scan = FILE_START;
	let lastChange = 0;
	for (const [index, line] of lines.entries()) {
		const next = readLine(scan, line, true).scan;
		// readLine hands back the same fence while it stays open, so a
		// different one means this line opened or closed a fence.
		if (next.fence !== scan.fence) lastChange = index;
		scan = next;
	}
	scan = FILE_START;
	return lines.map((line, index) => {
		const read = readLine(scan, line, index < lastChange);
		scan = read.scan;
		return read.quoted;
	});
}

/**
 * The complete start/end pairs in `lines`, in order. A marker out of place
 * (an end with nothing open, a start while another is open, a start left
 * open) is refused by line number:
 * guessing which half was meant would rewrite text the person wrote. A
 * marker inside a closed fenced code block or in indented code is quoted
 * text, not the block; the fence still open at the end of the file is not a
 * fence, so from its opener on no fence hides a marker (the fences that did
 * close still protect what they quote).
 */
function findBlocks(file: string, lines: string[]): MarkedBlock[] {
	const blocks: MarkedBlock[] = [];
	let openAt: number | null = null;
	let openDepth = 0;
	const quoted = quotedLines(lines);
	for (const [index, line] of lines.entries()) {
		if (quoted[index]) continue;
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
