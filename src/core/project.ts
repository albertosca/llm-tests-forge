import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import {
	isAlias,
	isMap,
	isNode,
	isScalar,
	isSeq,
	type Node,
	parseDocument,
	type Range,
	stringify,
} from "yaml";
import { ForgeError } from "./errors";
import { parseYamlText, readText } from "./files";
import {
	type Language,
	type ProjectConfig,
	ProjectConfigSchema,
} from "./schemas";

export const PROJECT_FILE = "forge.yaml";

/** `entry` as written in forge.yaml, `directory` absolute. */
export interface SuiteEntry {
	entry: string;
	directory: string;
}

export interface SuiteProblem {
	entry: string;
	reason: string;
}

export interface Project {
	root: string;
	file: string;
	config: ProjectConfig;
	text: string;
	suites: SuiteEntry[];
	problems: SuiteProblem[];
}

async function fileExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		// Stryker disable next-line ArrowFunction: the one caller reads the result as an `if` condition, where undefined is false too.
		() => false,
	);
}

/** The nearest directory at or above `startDirectory` that holds a forge.yaml, or null. */
export async function findProjectRoot(
	startDirectory: string,
): Promise<string | null> {
	const directory = resolve(startDirectory);
	if (await fileExists(join(directory, PROJECT_FILE))) return directory;
	const parent = dirname(directory);
	return parent === directory ? null : findProjectRoot(parent);
}

/**
 * The form two entries are compared in: normalized, without a trailing
 * slash. Joining "." does both, and leaves "/" itself as it is.
 */
export function comparableEntry(entry: string): string {
	return posix.join(entry, ".");
}

/** The message for a suite path written with a backslash, in forge.yaml or on --suite. */
export function backslashProblem(entry: string): string {
	return `suite "${entry}" uses a backslash; write paths with forward slashes`;
}

/** Why `entry` cannot be a suite of this project, or null when it can. */
function entryProblem(entry: string, seen: Set<string>): string | null {
	if (entry.includes("\\")) return backslashProblem(entry);
	// A forge.yaml is shared across platforms, so an entry absolute on any of
	// them is refused on all. Windows' rule is the wider one: it takes /evals
	// and //server/share as absolute, as POSIX does, and adds C:/evals.
	if (win32.isAbsolute(entry))
		return `suite "${entry}" is an absolute path; list it relative to forge.yaml`;
	const comparable = comparableEntry(entry);
	if (comparable === ".." || comparable.startsWith("../"))
		return `suite "${entry}" climbs out of the project`;
	if (seen.has(comparable)) return `suite "${entry}" is listed twice`;
	return null;
}

/**
 * Reads and validates `<root>/forge.yaml`. A file that does not parse or
 * match the schema throws (naming the file); a bad suite entry does not:
 * it lands in `problems` so every verb still works on the good suites.
 */
export async function readProject(root: string): Promise<Project> {
	const file = join(root, PROJECT_FILE);
	const text = await readText(file);
	const config = parseYamlText(file, text, ProjectConfigSchema);
	const suites: SuiteEntry[] = [];
	const problems: SuiteProblem[] = [];
	const seen = new Set<string>();
	for (const entry of config.suites) {
		const reason = entryProblem(entry, seen);
		if (reason !== null) {
			problems.push({ entry, reason });
			continue;
		}
		const comparable = comparableEntry(entry);
		seen.add(comparable);
		suites.push({ entry, directory: join(root, ...comparable.split("/")) });
	}
	return { root, file, config, text, suites, problems };
}

/**
 * How to register a suite that already exists (copied in, or made before
 * `init`): there is no verb for it, so the messages that meet one say this.
 */
export function registrationHint(entry: string): string {
	return `add its path to suites: in ${PROJECT_FILE} (for example \`suites: [${entry}]\`, or, when suites is already a block list, add a \`- ${entry}\` line with the same indentation as the existing entries)`;
}

/** The registered entries for messages: "evals/a, evals/b", or "none yet". */
export function registeredSuiteNames(project: Project): string {
	return project.suites.length === 0
		? "none yet"
		: project.suites.map((suite) => suite.entry).join(", ");
}

/**
 * The real path of `path` (symlinks followed), or null when it does not
 * exist. The native form spells every component as the disk does, so on a
 * filesystem that folds case `evals/suite` and `evals/Suite` compare equal;
 * Node's JavaScript `realpathSync` keeps the caller's spelling (Bun's
 * happens to match the native one, which no test can then tell apart).
 */
function realPathOrNull(path: string): string | null {
	try {
		return realpathSync.native(path);
	} catch {
		return null;
	}
}

/**
 * Whether a listed suite is the very directory `directory` (both exist and
 * resolve to the same real path), so a symlink to a suite is not registered
 * as a second suite.
 */
function listsSameDirectory(project: Project, directory: string): boolean {
	const target = realPathOrNull(directory);
	if (target === null) return false;
	return project.suites.some(
		(suite) => realPathOrNull(suite.directory) === target,
	);
}

/** The file's line ending: CRLF when it has one, LF otherwise. */
function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The index where the line holding `position` ends, before its line break. */
function lineEnd(text: string, position: number): number {
	const newline = text.indexOf("\n", position);
	if (newline === -1) return text.length;
	return text.charAt(newline - 1) === "\r" ? newline - 1 : newline;
}

/** The index where the line holding `position` starts. */
function lineStart(text: string, position: number): number {
	return text.lastIndexOf("\n", position - 1) + 1;
}

/** The spaces and tabs that start the line holding `position`. */
function indentationAt(text: string, position: number): string {
	const line = text.slice(lineStart(text, position));
	return line.slice(0, line.length - line.trimStart().length);
}

function insertAt(text: string, position: number, addition: string): string {
	return text.slice(0, position) + addition + text.slice(position);
}

/** Where a node parsed from text stands in it. */
function sourceRange(node: Node): Range {
	// Stryker disable next-line ArrayDeclaration: every node the parser builds has a range, so the fallback is never read
	return node.range ?? [0, 0, 0];
}

/**
 * `entry` as one item of a flow or a block list, quoted when that context
 * would misread it. A block list is the printer's default style.
 */
function listItemText(entry: string, flow: boolean): string {
	if (flow)
		return stringify([entry], {
			collectionStyle: "flow",
			flowCollectionPadding: false,
			lineWidth: 0,
		})
			.trimEnd()
			.slice(1, -1);
	return stringify([entry], { lineWidth: 0 }).trimEnd().slice(2);
}

/**
 * `text` with `- <entry>` on a line of its own after the block list's last
 * item, with the file's line ending, at the indentation of the list's first
 * dash: every dash of a block list stands there, while an item's value may
 * start on the line after its dash, further in.
 */
function appendToBlockList(text: string, list: Range, entry: string): string {
	const line = `${lineEndingOf(text)}${indentationAt(text, list[0])}- ${listItemText(entry, false)}`;
	// The list's value ends with its last item's; a block scalar's runs past
	// its content to the next line.
	const contentEnd = text.slice(0, list[1]).trimEnd().length;
	return insertAt(text, lineEnd(text, contentEnd), line);
}

/**
 * `text` with `entry` added to an empty flow list: inside its brackets when
 * `]` shares the line of `[`; otherwise on a line of its own just before the
 * `]` line, at the indentation of the first line inside the brackets with
 * content, or two past the key's when there is none (a flow sequence in a
 * block mapping must be indented further than its key).
 */
function appendToEmptyFlowList(
	text: string,
	list: Range,
	item: string,
): string {
	const close = list[1] - 1;
	const closeLine = lineStart(text, close);
	if (closeLine <= list[0]) return insertAt(text, close, item);
	const inside = text.slice(lineEnd(text, list[0]), closeLine).split("\n");
	const firstWithContent = inside.find((line) => line.trim() !== "");
	const indentation =
		firstWithContent === undefined
			? `${indentationAt(text, list[0])}  `
			: indentationAt(firstWithContent, 0);
	return insertAt(
		text,
		closeLine,
		`${indentation}${item}${lineEndingOf(text)}`,
	);
}

/**
 * Throws, naming forge.yaml, unless `text` reads back with `suites` exactly
 * the project's entries followed by `entry`: whatever shape of forge.yaml a
 * splice did not foresee, it never writes a broken file.
 */
export function checkRegisteredText(
	project: Project,
	text: string,
	entry: string,
): void {
	const document = parseDocument(text);
	const suites: unknown =
		document.errors.length === 0 ? document.toJS()?.suites : undefined;
	if (
		JSON.stringify(suites) !== JSON.stringify([...project.config.suites, entry])
	)
		throw new ForgeError(
			`registering ${entry} would write a forge.yaml that does not read back as the listed suites plus this one, so it was left unchanged; ${registrationHint(entry)}`,
			{ file: project.file },
		);
}

/**
 * `text` with `entry` added to a flow list (an empty one is
 * `appendToEmptyFlowList`'s). A last item on a line of its own, with the `]` on a later
 * line, is followed by a new line at its indentation; otherwise `, <entry>`
 * follows the last item on its line. A trailing comma stays trailing.
 */
function appendToFlowList(
	text: string,
	list: Range,
	lastItem: Range | null,
	entry: string,
): string {
	const item = listItemText(entry, true);
	if (lastItem === null) return appendToEmptyFlowList(text, list, item);
	// A flow sequence's value ends right after its `]`.
	const close = list[1] - 1;
	const valueEnd = lastItem[1];
	const comma = /^[ \t]*,/.exec(text.slice(valueEnd));
	const afterComma = comma === null ? null : valueEnd + comma[0].length;
	const ownLine =
		lineStart(text, lastItem[0]) > list[0] &&
		lineStart(text, close) > lineStart(text, valueEnd);
	if (!ownLine)
		return afterComma === null
			? insertAt(text, valueEnd, `, ${item}`)
			: insertAt(text, afterComma, ` ${item},`);
	const line = `${lineEndingOf(text)}${indentationAt(text, lastItem[0])}${item}`;
	if (afterComma !== null)
		return insertAt(text, lineEnd(text, afterComma), `${line},`);
	return insertAt(insertAt(text, lineEnd(text, valueEnd), line), valueEnd, ",");
}

/**
 * The forge.yaml text with `suiteDirectory` added to `suites`, or null when
 * it is already listed. A list already there is extended in the original
 * text, so every other byte (comments, spacing, line endings) stays as the
 * person wrote it. A missing or null `suites` is set through the document:
 * its comments survive, spacing is the printer's, and a CRLF file stays
 * CRLF. A `suites` that is a YAML alias is refused: replacing it would drop
 * the entries it stands for. It reads the filesystem only to compare real
 * paths.
 */
export function registerSuite(
	project: Project,
	suiteDirectory: string,
): { text: string; entry: string } | null {
	// The project root itself relates to itself as "", which is no entry.
	const entry =
		relative(project.root, resolve(suiteDirectory)).split(sep).join("/") || ".";
	if (isAbsolute(entry) || entry === ".." || entry.startsWith("../"))
		throw new ForgeError(
			`${suiteDirectory} is outside the project at ${project.root}; a suite must live inside it`,
			{ file: project.file },
		);
	const comparable = comparableEntry(entry);
	if (
		project.suites.some((suite) => comparableEntry(suite.entry) === comparable)
	)
		return null;
	if (listsSameDirectory(project, resolve(suiteDirectory))) return null;
	const document = parseDocument(project.text);
	const suites = document.get("suites", true);
	if (isAlias(suites))
		throw new ForgeError(
			`suites: is a YAML alias, which registering cannot extend; ${registrationHint(entry)}`,
			{ file: project.file },
		);
	if (isSeq(suites)) {
		const list = sourceRange(suites);
		const last = suites.items.at(-1);
		const text =
			suites.flow === true
				? appendToFlowList(
						project.text,
						list,
						isNode(last) ? sourceRange(last) : null,
						entry,
					)
				: appendToBlockList(project.text, list, entry);
		checkRegisteredText(project, text, entry);
		return { text, entry };
	}
	const replacement = document.createNode([entry]);
	if (isNode(suites)) {
		// A bare `suites:` has no value to hold its comments, so the parser
		// gives it every comment line up to the next key. The first stays on
		// the key's line when it stood on the value's (on the new block list
		// it would print below the item it was above); the lines below stay
		// below, above the new item.
		const valueEnd = sourceRange(suites)[1];
		const onValueLine = project.text
			.slice(valueEnd, lineEnd(project.text, valueEnd))
			.includes("#");
		// A CRLF file's comment lines are joined by "\r\n"; the printer joins
		// them by "\n" and the whole text is turned CRLF afterwards.
		const lines = (comment: string | null | undefined): string[] =>
			comment?.split(/\r?\n/) ?? [];
		const below = lines(suites.comment);
		const keyComment = onValueLine ? below.shift() : undefined;
		replacement.commentBefore = [...lines(suites.commentBefore), ...below].join(
			"\n",
		);
		// Stryker disable next-line ConditionalExpression,ArrayDeclaration: suites is a node only inside a map document (readProject read the file with ProjectConfigSchema, an object; the project test "readProject refuses a forge.yaml that is not a map" guards it), so the empty list is never iterated; the guard is for the type alone
		const pairs = isMap(document.contents) ? document.contents.items : [];
		for (const pair of pairs) {
			// Stryker disable next-line ConditionalExpression: for the type alone: a key that is not a scalar has no value "suites" either way
			if (!isScalar(pair.key)) continue;
			if (pair.key.value === "suites") pair.key.comment = keyComment;
		}
	}
	document.set("suites", replacement);
	const printed = document.toString({
		flowCollectionPadding: false,
		lineWidth: 0,
	});
	const text =
		lineEndingOf(project.text) === "\r\n"
			? printed.replaceAll("\n", "\r\n")
			: printed;
	checkRegisteredText(project, text, entry);
	return { text, entry };
}

/** What `init` writes as the project file. */
export function projectFileText(language: Language): string {
	return [
		"# llm-tests-forge project file. `llm-tests-forge guide` explains every key.",
		"version: 1",
		`language: ${language}`,
		"suites: []",
		// An empty `defaults:` reads as {}; deleting a "# " below gives a valid key.
		"defaults:",
		"  # drafter: google/gemini-3.5-flash",
		"  # target_models: [anthropic/claude-haiku-4-5]",
		"  # judges: [google/gemini-3.5-flash]",
		"",
	].join("\n");
}
