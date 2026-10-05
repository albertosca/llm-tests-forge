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

/** A list item's marker: `-`, `*`, `+`, or a number with `.` or `)`. */
const LIST_MARKER = /[-*+]|\d{1,9}[.)]/g;

/**
 * What stands before a marker: indentation, blockquote `>`s and list item
 * markers (each followed by whitespace), in any order. It matches at the
 * start of every line (with nothing when the line has none of them), so it
 * needs no `^`; and a marker's whitespace past the first character is taken
 * by the `[ \t>]` alternative.
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

// The block patterns of commonmark.js 0.31.2, for a line whose tabs are
// expanded (so only spaces stand for whitespace), read from its first
// character that is not a space.
const ATX_HEADING = /^#{1,6}(?: |$)/;
const FENCE_OPENER = /^`{3,}(?!.*`)|^~{3,}/;
const FENCE_CLOSER = /^(?:`{3,}|~{3,})(?= *$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+) *$/;
const THEMATIC_BREAK = /^(?:\* *){3,}$|^(?:_ *){3,}$|^(?:- *){3,}$/;
const LIST_ITEM = /^(?:[*+-]|(\d{1,9})[.)])/;
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)`;

/**
 * The seven kinds of HTML block, in CommonMark's order: what opens each,
 * and what ends it on the line it reaches (none: a blank line ends it).
 * The seventh, a lone complete tag, cannot interrupt a paragraph.
 */
const HTML_BLOCKS: { opener: RegExp; end?: RegExp }[] = [
	{
		opener: /^<(?:script|pre|textarea|style)(?:\s|>|$)/i,
		end: /<\/(?:script|pre|textarea|style)>/i,
	},
	{ opener: /^<!--/, end: /-->/ },
	{ opener: /^<[?]/, end: /\?>/ },
	{ opener: /^<![A-Za-z]/, end: />/ },
	{ opener: /^<!\[CDATA\[/, end: /\]\]>/ },
	{
		opener:
			/^<[/]?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[123456]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|search|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|[/]?[>]|$)/i,
	},
	// commonmark.js gives this one the `i` flag too; its classes already
	// hold both cases, so it is left out.
	{
		opener: new RegExp(
			`^(?:<${TAG_NAME}${ATTRIBUTE}*\\s*/?>|</${TAG_NAME}\\s*[>])\\s*$`,
		),
	},
];

/** A block the scan is inside: containers first, then at most one leaf. */
type Block =
	| { kind: "quote" }
	/** `width` is how far a line must be indented to stay in the item; `empty`, whether nothing is in it yet. */
	| { kind: "item"; width: number; empty: boolean }
	| { kind: "paragraph" }
	| { kind: "fence"; character: string; length: number }
	| { kind: "html"; end: RegExp | undefined };

/** `blocks` with `block` opened inside the last one: an empty list item then holds something. Without `block`, a leaf opened and closed on the same line. */
function openInside(blocks: Block[], block?: Block): Block[] {
	const last = blocks.at(-1);
	const filled =
		// Stryker disable next-line ConditionalExpression: only an item reads `empty`, so a blockquote copied with it reads the same; the copy's new identity can move quotedLines' last change only past lines that open no fence (an opener is itself a change)
		last?.kind === "item"
			? [...blocks.slice(0, -1), { ...last, empty: false }]
			: blocks;
	return block === undefined ? filled : [...filled, block];
}

/** What is open before the first line. */
// Stryker disable next-line ArrayDeclaration: a placeholder in it has no kind, so every line continues it like the document itself and it changes nothing
const NOTHING_OPEN: Block[] = [];

/** A line inside code: a fence's opener, content or closer, or indented code. */
const codeLine = (blocks: Block[]) => ({ blocks, quoted: true });

/** Any other line. Headings, breaks, underlines and blank lines cannot be a marker at all, so they need no kind of their own. */
const textLine = (blocks: Block[]) => ({ blocks, quoted: false });

/**
 * The blocks open after `line`, and whether the line is quoted: a fence's
 * opener, content or closer, or indented code, so that it cannot be a
 * marker. It follows commonmark.js's block parser, step by step:
 * - each open block, outermost first, either continues on the line (a `>`
 *   for a blockquote, enough indentation or a blank line for a list item)
 *   or ends, with everything inside it;
 * - then new blocks start, in CommonMark's order: blockquote, ATX heading,
 *   fence, HTML block, setext underline, thematic break, list item, and
 *   indented code, which cannot interrupt a paragraph;
 * - what is left is a paragraph's line, a lazy one when the paragraph's
 *   containers did not all continue.
 * `mayOpen` false reads a fence opener as text (see `quotedLines`).
 */
function readLine(
	blocks: Block[],
	line: string,
	mayOpen: boolean,
): { blocks: Block[]; quoted: boolean } {
	const text = expandTabs(line.endsWith("\r") ? line.slice(0, -1) : line);
	let offset = 0;
	let matched = 0;
	for (const block of blocks) {
		const nonspace = offset + indentOf(text.slice(offset));
		const indent = nonspace - offset;
		const blank = nonspace === text.length;
		if (block.kind === "quote") {
			if (indent > 3 || text.charAt(nonspace) !== ">") break;
			offset = text.charAt(nonspace + 1) === " " ? nonspace + 2 : nonspace + 1;
		} else if (block.kind === "item") {
			if (blank ? block.empty : indent < block.width) break;
			offset = blank ? nonspace : offset + block.width;
		} else if (block.kind === "fence") {
			const closer =
				indent > 3 ? null : FENCE_CLOSER.exec(text.slice(nonspace));
			const closes =
				closer !== null &&
				closer[0].charAt(0) === block.character &&
				closer[0].length >= block.length;
			return codeLine(closes ? blocks.slice(0, matched) : blocks);
		} else if (block.kind === "html") {
			if (blank && block.end === undefined) break;
			const ends = block.end?.test(text.slice(offset)) === true;
			return textLine(ends ? blocks.slice(0, matched) : blocks);
		}
		// A paragraph continues here on any line: a blank one ends it below,
		// where the paragraph is never kept for a blank line.
		matched += 1;
	}
	const paragraphOpen = blocks.at(-1)?.kind === "paragraph";
	// The paragraph itself continued: CommonMark calls it the container.
	const inParagraph = paragraphOpen && matched === blocks.length;
	// What a new block opens inside: a block that starts ends the paragraph.
	let open = blocks.slice(0, inParagraph ? matched - 1 : matched);
	let started = false;
	for (;;) {
		const nonspace = offset + indentOf(text.slice(offset));
		const rest = text.slice(nonspace);
		// Until a block starts on this line, an open paragraph is still the tip.
		const afterParagraph = paragraphOpen && !started;
		// Indented code. The next line restarts it as readily as it would
		// continue it (the tip is no paragraph either way), so it is not
		// kept among the open blocks.
		if (nonspace - offset >= 4) {
			if (rest === "" || afterParagraph) break;
			return codeLine(openInside(open));
		}
		if (rest.startsWith(">")) {
			open = openInside(open, { kind: "quote" });
			offset = rest.charAt(1) === " " ? nonspace + 2 : nonspace + 1;
			started = true;
			continue;
		}
		if (ATX_HEADING.test(rest)) return textLine(openInside(open));
		const fence = mayOpen ? FENCE_OPENER.exec(rest) : null;
		if (fence !== null)
			return codeLine(
				openInside(open, {
					kind: "fence",
					character: fence[0].charAt(0),
					length: fence[0].length,
				}),
			);
		const html = HTML_BLOCKS.find(
			(kind, index) => kind.opener.test(rest) && (index < 6 || !afterParagraph),
		);
		if (html !== undefined)
			return textLine(
				html.end?.test(text.slice(offset))
					? openInside(open)
					: openInside(open, { kind: "html", end: html.end }),
			);
		if (inParagraph && !started && SETEXT_UNDERLINE.test(rest))
			return textLine(open);
		if (THEMATIC_BREAK.test(rest)) return textLine(openInside(open));
		const item = LIST_ITEM.exec(rest);
		const after = rest.slice(item?.[0].length);
		const spaces = indentOf(after);
		const emptyItem = spaces === after.length;
		if (
			item === null ||
			(spaces === 0 && !emptyItem) ||
			(inParagraph &&
				!started &&
				(emptyItem || (item[1] !== undefined && Number(item[1]) !== 1)))
		)
			break;
		const padding = item[0].length + (emptyItem || spaces > 4 ? 1 : spaces);
		open = openInside(open, {
			kind: "item",
			width: nonspace - offset + padding,
			empty: true,
		});
		offset = Math.min(nonspace + padding, text.length);
		started = true;
	}
	const blank = offset + indentOf(text.slice(offset)) === text.length;
	if (blank) return textLine(open);
	// A paragraph's next line, or a lazy one: nothing closes.
	if (paragraphOpen && !started) return textLine(blocks);
	return textLine(openInside(open, { kind: "paragraph" }));
}

/**
 * For each line, whether it is quoted (see `readLine`). Fences are honored
 * up to the last line that changes the innermost open block, and from it on
 * no fence opens. Nothing inside a fence changes it, so when a fence never
 * closes, that line is its opener: CommonMark would call the rest of the
 * file code, but a person never meant that. When the line closes a fence,
 * or starts something else, no fence opens after it anyway. Exported for
 * its test.
 */
export function quotedLines(lines: string[]): boolean[] {
	let blocks = NOTHING_OPEN;
	let lastChange = 0;
	for (const [index, line] of lines.entries()) {
		const next = readLine(blocks, line, true).blocks;
		// readLine hands back the same blocks while a fence stays open.
		if (next.at(-1) !== blocks.at(-1)) lastChange = index;
		blocks = next;
	}
	blocks = NOTHING_OPEN;
	return lines.map((line, index) => {
		const read = readLine(blocks, line, index < lastChange);
		blocks = read.blocks;
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
