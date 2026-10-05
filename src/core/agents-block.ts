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

// commonmark.js's link reference definition (its parseReference), which
// decides whether a setext underline makes a heading: not when the
// paragraph above it holds definitions alone.
//
// Rewritten where the meaning stays the same, each proved by the
// definitions fuzz against commonmark.js:
// - ESCAPABLE and DESTINATION_STOP test one character, so they need no anchor;
// - SPACES_AND_ONE_LINE_BREAK may match nothing, so it always matches at the start;
// - a paragraph's text always ends with a line break, so a line's end is
//   a line break, never the end of the text;
// - commonmark.js spells an escape in a title as an escapable character or
//   any other but a backslash, which together are any character;
// - a `)` with none open makes the line no definition, however it is read.
const LINK_LABEL = /^\[(?:[^\\[\]]|\\.){0,1000}\]/s;
const ESCAPABLE = /[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/;
const DESTINATION_IN_BRACES = /^<(?:[^<>\n\\]|\\.)*>/;
const LINK_TITLE =
	/^(?:"(?:\\[\s\S]|[^\\"])*"|'(?:\\[\s\S]|[^\\'])*'|\((?:\\[\s\S]|[^\\()])*\))/;
const SPACES_AND_ONE_LINE_BREAK = / *(?:\n *)?/;
const SPACES_TO_LINE_END = /^ *\n/;
const DESTINATION_STOP = /[ \t\n\v\f\r]/;

/** The position past the spaces, and at most one line break, from `position` on. */
function pastSpaces(subject: string, position: number): number {
	return (
		subject.length -
		subject.slice(position).replace(SPACES_AND_ONE_LINE_BREAK, "").length
	);
}

/** Where a link destination from `start` ends, if one does. */
function destinationEnd(subject: string, start: number): number | undefined {
	const braced = DESTINATION_IN_BRACES.exec(subject.slice(start));
	if (braced !== null) return start + braced[0].length;
	if (subject.charAt(start) === "<") return undefined;
	let position = start;
	let parentheses = 0;
	let character = subject.charAt(position);
	while (character !== "" && !DESTINATION_STOP.test(character)) {
		if (character === "\\" && ESCAPABLE.test(subject.charAt(position + 1)))
			position += 1;
		else if (character === "(") parentheses += 1;
		else if (character === ")") {
			if (parentheses === 0) return undefined;
			parentheses -= 1;
		}
		position += 1;
		character = subject.charAt(position);
	}
	// An empty destination stops at a tab, a vertical tab or a form feed
	// (spaces and the one line break allowed were skipped before it, and a
	// second line break would end the paragraph), so no line end follows
	// and the definition fails anyway: it needs no check of its own.
	return parentheses === 0 ? position : undefined;
}

/** Where the line from `position` ends past its trailing spaces and line break, if nothing else stands there. */
function lineEnd(subject: string, position: number): number | undefined {
	const found = SPACES_TO_LINE_END.exec(subject.slice(position));
	return found === null ? undefined : position + found[0].length;
}

/** The length of the link reference definition `subject` starts with, or 0. */
function definitionLength(subject: string): number {
	const label = LINK_LABEL.exec(subject)?.[0];
	if (
		label === undefined ||
		label.length > 1001 ||
		subject.charAt(label.length) !== ":"
	)
		return 0;
	const destination = destinationEnd(
		subject,
		pastSpaces(subject, label.length + 1),
	);
	// Stryker disable next-line ConditionalExpression: with no destination the lines below read the subject from its start, a `[`, which is neither a title nor a line end, so 0 comes back either way; the check is for the type
	if (destination === undefined) return 0;
	const titleStart = pastSpaces(subject, destination);
	const title =
		titleStart === destination
			? null
			: LINK_TITLE.exec(subject.slice(titleStart));
	// A title that does not end its line is dropped, and the destination
	// must end it instead.
	const end =
		(title === null
			? undefined
			: lineEnd(subject, titleStart + title[0].length)) ??
		lineEnd(subject, destination);
	return end === undefined || label.slice(1, -1).trim() === "" ? 0 : end;
}

/** Whether a paragraph's text is link reference definitions and nothing else. */
function onlyDefinitions(text: string): boolean {
	let rest = text;
	while (rest !== "") {
		const length = definitionLength(rest);
		if (length === 0) return false;
		rest = rest.slice(length);
	}
	return true;
}

/** A block the scan is inside: containers first, then at most one leaf. */
type Block =
	| { kind: "quote" }
	/** `width` is how far a line must be indented to stay in the item; `empty`, whether nothing is in it yet. */
	| { kind: "item"; width: number; empty: boolean }
	/** `text` is the paragraph's lines as CommonMark keeps them: from their first character that is not a space, each with its line break. */
	| { kind: "paragraph"; text: string }
	| { kind: "fence"; character: string; length: number }
	/** `end` is the pattern that ends the block on the line it reaches; none for the kinds a blank line ends. */
	| { kind: "html"; end: RegExp | undefined };

/** Containers a line may nest before the reader refuses the file: past this, each line would cost time with no file that needs it. */
const DEEPEST = 100;

/**
 * `blocks` with `block` opened inside the last one, which then holds
 * something: an empty list item stops being empty (only an item reads
 * `empty`). Without `block`, a leaf opened and closed on the same line.
 */
function openInside(blocks: Block[], block?: Block): Block[] {
	const filled = [
		...blocks.slice(0, -1),
		...blocks.slice(-1).map((last) => ({ ...last, empty: false })),
	];
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
 * A line inside a raw HTML block that only its end pattern closes
 * (`<script>`, `<pre>`, `<style>`, `<textarea>`, a comment, `<?`, `<!X`,
 * CDATA) is quoted like code; one inside a block a blank line ends
 * (`<div>`, a lone tag) is not. `place` names the line in a refusal.
 */
function readLine(
	blocks: Block[],
	line: string,
	mayOpen: boolean,
	place: string,
): { blocks: Block[]; quoted: boolean } {
	// A CRLF line's CR is its line break; CommonMark reads a NUL as U+FFFD.
	const source = (line.endsWith("\r") ? line.slice(0, -1) : line).replaceAll(
		"\0",
		"�",
	);
	const text = expandTabs(source);
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
			const next = ends ? blocks.slice(0, matched) : blocks;
			return block.end === undefined ? textLine(next) : codeLine(next);
		}
		// A paragraph continues here on any line: a blank one ends it below,
		// where the paragraph is never kept for a blank line.
		matched += 1;
	}
	const tip = blocks.at(-1);
	const paragraph = tip?.kind === "paragraph" ? tip : undefined;
	const paragraphOpen = paragraph !== undefined;
	// The paragraph itself continued: CommonMark calls it the container.
	const inParagraph = paragraph !== undefined && matched === blocks.length;
	/** `open` with a blockquote or list item inside it, refused past DEEPEST. */
	const openContainer = (container: Block): Block[] => {
		if (open.length >= DEEPEST)
			throw new ForgeError(
				`${place} nests more than ${DEEPEST} blockquotes and list items; llm-tests-forge does not read that deep`,
			);
		return openInside(open, container);
	};
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
			open = openContainer({ kind: "quote" });
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
		// An underline under definitions alone makes no heading: the
		// paragraph goes on, and the line is its text.
		if (
			inParagraph &&
			!started &&
			SETEXT_UNDERLINE.test(rest) &&
			!onlyDefinitions(paragraph.text)
		)
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
		open = openContainer({
			kind: "item",
			width: nonspace - offset + padding,
			empty: true,
		});
		offset = Math.min(nonspace + padding, text.length);
		started = true;
	}
	const contentStart = offset + indentOf(text.slice(offset));
	if (contentStart === text.length) return textLine(open);
	const content = `${sourceFrom(source, contentStart)}\n`;
	// A paragraph's next line, or a lazy one: nothing closes.
	if (paragraph !== undefined && !started)
		return textLine([
			...blocks.slice(0, -1),
			{ kind: "paragraph", text: paragraph.text + content },
		]);
	return textLine(openInside(open, { kind: "paragraph", text: content }));
}

/**
 * `source` from the character that expands to `column` (see `expandTabs`):
 * a paragraph's text is the line as written, tabs and all, since a tab
 * after a link destination keeps it from being a definition.
 */
function sourceFrom(source: string, column: number): string {
	let index = 0;
	for (let reached = 0; reached < column; index += 1)
		reached += source.charAt(index) === "\t" ? 4 - (reached % 4) : 1;
	return source.slice(index);
}

/**
 * For each line, whether it is quoted (see `readLine`). Fences are honored
 * up to the last line that changes the innermost open block, and from it on
 * no fence opens. Nothing inside a fence changes it, so when a fence never
 * closes, that line is its opener: CommonMark would call the rest of the
 * file code, but a person never meant that. When the line closes a fence,
 * or starts something else, no fence opens after it anyway. Exported for
 * its test.
 *
 * This is the one place the reader knowingly reads less as code than
 * CommonMark: a fence still open at the end of the file. Inside a
 * blockquote the file's last, empty line ends the quote and the fence with
 * it, so such a fence did close and quotes what it holds, as CommonMark
 * does; inside a list item the empty line keeps the item, the fence stays
 * open, and what it holds is read as text (the tests "a fence still open at
 * the end of the file, inside a blockquote…" and "…inside a list item…"
 * pin both). Everything else follows commonmark.js 0.31.2: a carriage
 * return that does not end a line, which it would read as a line break, is
 * refused by planAgentsBlock, and a byte order mark is read past there
 * (towards more code).
 */
export function quotedLines(file: string, lines: string[]): boolean[] {
	let blocks = NOTHING_OPEN;
	let lastChange = 0;
	const place = (index: number): string => `${file} line ${index + 1}`;
	for (const [index, line] of lines.entries()) {
		const next = readLine(blocks, line, true, place(index)).blocks;
		// readLine hands back the same blocks while a fence stays open.
		if (next.at(-1) !== blocks.at(-1)) lastChange = index;
		blocks = next;
	}
	blocks = NOTHING_OPEN;
	return lines.map((line, index) => {
		const read = readLine(blocks, line, index < lastChange, place(index));
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
	const quoted = quotedLines(file, lines);
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
 *
 * A leading byte order mark stays in the file but is read past. CommonMark
 * reads it as text, so the reader errs here towards more code: an indented
 * first line after the mark is indented code to it, and never replaced (the
 * test "a leading byte order mark…" pins it). A carriage return that does
 * not end a line is refused: CommonMark breaks the line there and the
 * reader would not.
 */
export function planAgentsBlock(
	file: string,
	existing: string | null,
): { text: string; replaced: boolean } {
	if (existing === null) return { text: `${agentsBlock()}\n`, replaced: false };
	const mark = existing.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
	const planned = planWithoutMark(file, existing.slice(mark.length));
	return { text: mark + planned.text, replaced: planned.replaced };
}

const BYTE_ORDER_MARK = "﻿";

/** `planAgentsBlock` for a file with no byte order mark. */
function planWithoutMark(
	file: string,
	existing: string,
): { text: string; replaced: boolean } {
	const block = agentsBlock();
	const loneCarriage = existing.search(/\r(?!\n)/);
	if (loneCarriage >= 0)
		throw new ForgeError(
			`${file} line ${existing.slice(0, loneCarriage).split("\n").length} holds a carriage return that does not end the line (a lone CR, or CR CR LF); normalise its line endings to LF or CRLF and run init again`,
		);
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
