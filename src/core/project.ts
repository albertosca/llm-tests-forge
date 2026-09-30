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
} from "node:path";
import {
	isAlias,
	isNode,
	isSeq,
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
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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

/** The form two entries are compared in: normalized, without a trailing slash. */
export function comparableEntry(entry: string): string {
	const normalized = posix.normalize(entry);
	return normalized.length > 1 && normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
}

/** The message for a suite path written with a backslash, in forge.yaml or on --suite. */
export function backslashProblem(entry: string): string {
	return `suite "${entry}" uses a backslash; write paths with forward slashes`;
}

/** Why `entry` cannot be a suite of this project, or null when it can. */
function entryProblem(entry: string, seen: Set<string>): string | null {
	if (entry.includes("\\")) return backslashProblem(entry);
	if (isAbsolute(entry) || posix.isAbsolute(entry))
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

/** Where a node parsed from text stands in it; every parsed node has this. */
function sourceRange(node: unknown): Range {
	if (!isNode(node) || !node.range) throw new Error("node has no range");
	return node.range;
}

/** `entry` as one item of a flow or a block list, quoted when that context would misread it. */
function listItemText(entry: string, flow: boolean): string {
	const printed = stringify([entry], {
		collectionStyle: flow ? "flow" : "block",
		flowCollectionPadding: false,
		lineWidth: 0,
	}).trimEnd();
	return flow ? printed.slice(1, -1) : printed.slice(2);
}

/**
 * `text` with `- <entry>` on a line of its own after the last item of a
 * block list, at that item's indentation, with the file's line ending.
 */
function appendToBlockList(
	text: string,
	lastItem: Range,
	entry: string,
): string {
	const line = `${lineEndingOf(text)}${indentationAt(text, lastItem[0])}- ${listItemText(entry, false)}`;
	return insertAt(text, lineEnd(text, lastItem[1]), line);
}

/**
 * `text` with `entry` added to a flow list. An empty list gets it inside
 * its brackets. A last item on a line of its own, with the `]` on a later
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
	// A flow sequence's value ends right after its `]`.
	const close = list[1] - 1;
	if (lastItem === null) return insertAt(text, close, item);
	const valueEnd = lastItem[1];
	const comma = /^[ \t]*,/.exec(text.slice(valueEnd));
	const afterComma = comma === null ? null : valueEnd + comma[0].length;
	const ownLine =
		lineStart(text, lastItem[0]) > list[0] && lineStart(text, close) > valueEnd;
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
		const lastItem = last === undefined ? null : sourceRange(last);
		const text =
			suites.flow === true
				? appendToFlowList(project.text, list, lastItem, entry)
				: appendToBlockList(project.text, sourceRange(last), entry);
		return { text, entry };
	}
	const replacement = document.createNode([entry]);
	if (isNode(suites)) {
		replacement.comment = suites.comment;
		replacement.commentBefore = suites.commentBefore;
	}
	document.set("suites", replacement);
	const printed = document.toString({
		flowCollectionPadding: false,
		lineWidth: 0,
	});
	return {
		text:
			lineEndingOf(project.text) === "\r\n"
				? printed.replaceAll("\n", "\r\n")
				: printed,
		entry,
	};
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
