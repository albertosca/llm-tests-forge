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
import { isNode, isSeq, parseDocument } from "yaml";
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
	return `add its path to suites: in ${PROJECT_FILE} (for example \`suites: [${entry}]\`, or, when suites is already a block list, add a \`  - ${entry}\` line)`;
}

/** The registered entries for messages: "evals/a, evals/b", or "none yet". */
export function registeredSuiteNames(project: Project): string {
	return project.suites.length === 0
		? "none yet"
		: project.suites.map((suite) => suite.entry).join(", ");
}

/** The real path of `path` (symlinks followed), or null when it does not exist. */
function realPathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
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

/**
 * The forge.yaml text with `suiteDirectory` added to `suites`, or null when
 * it is already listed. Edited through the document so every comment
 * survives; spacing is the printer's, as with `rewriteSuiteInclude`. Pure.
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
	if (isSeq(suites)) {
		suites.items.push(document.createNode(entry));
	} else {
		const replacement = document.createNode([entry]);
		if (isNode(suites)) {
			replacement.comment = suites.comment;
			replacement.commentBefore = suites.commentBefore;
		}
		document.set("suites", replacement);
	}
	return {
		text: document.toString({ flowCollectionPadding: false, lineWidth: 0 }),
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
