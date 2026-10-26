import { randomUUID } from "node:crypto";
import {
	access,
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	isMap,
	isScalar,
	isSeq,
	Pair,
	parse,
	parseDocument,
	Scalar,
	stringify,
	type YAMLMap,
} from "yaml";
import type { core, ZodType } from "zod";
import { z } from "zod";
import { ForgeError, messageOf } from "./errors";
import {
	type Case,
	CaseSchema,
	type Feature,
	FeatureSchema,
	type Language,
	type Scenario,
	ScenarioSchema,
	type Suite,
	SuiteSchema,
} from "./schemas";
import { DEFAULT_ENTRY } from "./target";
import { isHigherVersion } from "./version";

export interface ForgePaths {
	root: string;
	feature: string;
	scenarios: string;
	casesDir: string;
	suite: string;
	usage: string;
	failuresDir: string;
	promptfooConfig: string;
	casesJsonl: string;
	reportMd: string;
	reportJson: string;
	stamp: string;
}

export function forgePaths(forgeDirectory: string): ForgePaths {
	return {
		root: forgeDirectory,
		feature: join(forgeDirectory, "feature.yaml"),
		scenarios: join(forgeDirectory, "scenarios.yaml"),
		casesDir: join(forgeDirectory, "cases"),
		suite: join(forgeDirectory, "suite.yaml"),
		usage: join(forgeDirectory, "usage.jsonl"),
		failuresDir: join(forgeDirectory, "failures"),
		promptfooConfig: join(forgeDirectory, "promptfooconfig.yaml"),
		casesJsonl: join(forgeDirectory, "cases.jsonl"),
		reportMd: join(forgeDirectory, "report.md"),
		reportJson: join(forgeDirectory, "report.json"),
		stamp: join(forgeDirectory, "stamp.json"),
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		// Stryker disable next-line ArrowFunction: every caller reads the result as `!(await exists(...))`, where undefined is false.
		() => false,
	);
}

function hasCode(error: unknown): error is { code: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		// Stryker disable next-line ConditionalExpression: every caller compares the code with a string literal (`===`, or readFailure's `switch`), which a code of another type never equals, so a non-string code reads as no code either way.
		typeof (error as { code: unknown }).code === "string"
	);
}

/**
 * The OS tells us why a read failed; passing that on is the difference
 * between "the file is not there" and "you pointed at a directory" or
 * "you cannot read it" — three different fixes for the person. Exported for
 * the two readers outside `readYamlFile` that need the same causes:
 * `estimate.ts`'s `promptTokensFor`, which reads the feature's prompt file,
 * and `src/report/results.ts`'s `readResults`, which reads promptfoo's JSON
 * output — neither is YAML, so neither goes through `readYamlFile`.
 */
export function readFailure(error: unknown): string {
	const code = hasCode(error) ? error.code : undefined;
	switch (code) {
		case "ENOENT":
			return "file not found";
		case "EISDIR":
			return "is a directory, expected a file";
		case "EACCES":
		case "EPERM":
			return "permission denied";
		default:
			return `cannot read: ${messageOf(error)}`;
	}
}

/**
 * `does not match schema` reports each issue by its zod path, e.g.
 * `2.oracle: ...` for the third array element -- a bare index tells the
 * person nothing about which reviewed item broke. When the issue is on an
 * array element that itself carries a string `id` (every top-level forge
 * list does), name that id and the index instead of the bare number; every
 * other issue (a non-array file, or an array element without an `id`)
 * keeps the plain `path: message` form, and an issue on the whole file
 * (an empty path) the message alone. The element is looked up by its
 * index, once per issue: walking the items for each issue made a file with
 * thousands of broken items quadratic. Exported for its test.
 */
export function describeIssue(issue: core.$ZodIssue, data: unknown): string {
	const [index] = issue.path;
	// On an array, zod's path starts with the element's index, or is empty
	// for an issue on the array itself: NaN then finds no element.
	const item: unknown = Array.isArray(data) ? data[Number(index)] : undefined;
	if (
		typeof item === "object" &&
		item !== null &&
		"id" in item &&
		typeof item.id === "string"
	) {
		const inside = issue.path
			.slice(1)
			.map((step) => `.${String(step)}`)
			.join("");
		return `item "${item.id}" (index ${String(index)})${inside}: ${issue.message}`;
	}
	if (issue.path.length === 0) return issue.message;
	return `${issue.path.join(".")}: ${issue.message}`;
}

/** A read whose failure names the file and the OS's reason, as every forge read does. */
export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8").catch((error: unknown) => {
		throw new ForgeError(readFailure(error), { file: path });
	});
}

/** How `writeText` puts the text into a file; the real one is `writeFile`. */
type WriteContent = (
	target: string,
	content: string,
	mode: number | undefined,
) => Promise<void>;

/** The two places a test reaches into `writeText`; production passes none. */
export interface WriteSeams {
	/** Replaces the write itself: a test fails half-way through with it. */
	writeContent?: WriteContent;
	/** Called once the temporary file holds the text, before anything else touches it. */
	afterTemporaryWritten?: (temporary: string) => Promise<void>;
}

/**
 * Creates the file with `mode` from the first byte (the umask can only
 * narrow it), so a temporary copy of a 0600 file is never world-readable,
 * not even until the `chmod` that follows.
 */
const writeWithMode: WriteContent = (target, content, mode) =>
	// Stryker disable next-line StringLiteral: Bun's writeFile takes an empty encoding for its default, utf8 (probed with accented, emoji and CJK text: the same bytes).
	writeFile(target, content, { encoding: "utf8", mode });

/** How many links `followSymlinks` follows before calling it a loop. */
const MAXIMUM_SYMLINK_HOPS = 40;

/**
 * The file `path` finally names, following symlinks one at a time, each
 * relative to its own link's directory. Every path that is not a link is
 * kept as given, so a failure names the file as the caller spelled it. A
 * dangling link resolves to the file it points at, which the write then
 * creates, as writing through the link always did; `realpath` refused it.
 */
async function followSymlinks(path: string): Promise<string> {
	let target = path;
	for (let hops = 0; ; hops += 1) {
		const isLink = await lstat(target).then(
			(entry) => entry.isSymbolicLink(),
			// Stryker disable next-line ArrowFunction: read only as `!isLink` on the next line, where undefined is false.
			() => false,
		);
		if (!isLink) return target;
		if (hops === MAXIMUM_SYMLINK_HOPS)
			throw new Error("too many levels of symbolic links");
		target = resolve(dirname(target), await readlink(target));
	}
}

/**
 * A write whose failure names the file: a name the filesystem refuses, a
 * directory that cannot be written into, a parent that is a file. The raw
 * `ENAMETOOLONG: name too long, open '...'` used to surface with no verb
 * owning it.
 *
 * All or nothing: the text goes to a temporary file beside the target,
 * which then replaces it in one rename. Writing in place, a full disk or a
 * killed process left half a file — a reviewed cases file cut off in the
 * middle of an entry. The temporary file is hidden, of fixed length (so a
 * name near the filesystem's limit is not pushed over it), and does not
 * end in `.yaml`, so no listing of the suite mistakes it for one of its
 * files; it is removed when anything fails.
 *
 * A rename would replace a read-only file, so the target is first opened
 * for writing, without truncating it: a file the person made read-only, a
 * directory, or a name the filesystem refuses fails there, with the same
 * message the in-place write gave, before anything is written. The
 * replaced file keeps its permissions, and a symlink is followed, so the
 * file it points at is the one replaced and the link stays a link. In a
 * directory that refuses new files, an existing file is written in place,
 * as it always was (not all or nothing there).
 *
 * The rename gives the target a new inode, which an in-place write did
 * not: another hard link to the old file keeps the old content, and the
 * new file belongs to whoever ran the forge (the old owner and group are
 * not carried over; only the permission bits are).
 */
export async function writeText(
	path: string,
	text: string,
	seams: WriteSeams = {},
): Promise<void> {
	const writeContent = seams.writeContent ?? writeWithMode;
	try {
		await mkdir(dirname(path), { recursive: true });
		const target = await followSymlinks(path);
		const existing = await open(target, "r+").catch((error: unknown) => {
			if (hasCode(error) && error.code === "ENOENT") return null;
			throw error;
		});
		const mode =
			existing === null ? undefined : (await existing.stat()).mode & 0o7777;
		await existing?.close();
		const temporary = join(dirname(target), `.forge-write-${randomUUID()}.tmp`);
		let temporaryWritten = false;
		try {
			await writeContent(temporary, text, mode);
			temporaryWritten = true;
			await seams.afterTemporaryWritten?.(temporary);
			if (mode !== undefined) await chmod(temporary, mode);
			await rename(temporary, target);
		} catch (error) {
			// Settled, not awaited bare: a failing cleanup must not replace
			// the error that says why the write failed.
			// Stryker disable next-line ObjectLiteral,BooleanLiteral: without force, rm refuses a temporary file never created with ENOENT, which allSettled swallows; one that exists is removed either way.
			await Promise.allSettled([rm(temporary, { force: true })]);
			// A refusal to create the temporary file is a refusal to write
			// the target: the message names the file the caller asked for,
			// not the hidden one nobody knows about.
			if (!temporaryWritten && error instanceof Error)
				error.message = error.message.replaceAll(temporary, target);
			// A directory the person made read-only still lets its existing
			// files be rewritten, which is what writing in place always did
			// there; only the temporary file cannot be created. That one
			// case is written in place, as before, rather than refused.
			const directoryRefused =
				!temporaryWritten &&
				existing !== null &&
				hasCode(error) &&
				(error.code === "EACCES" || error.code === "EPERM");
			if (!directoryRefused) throw error;
			await writeContent(target, text, mode);
		}
	} catch (error) {
		throw new ForgeError(`cannot write: ${messageOf(error)}`, {
			file: path,
		});
	}
}

/**
 * The last step of a move: the source is removed only after the
 * destination is written, so a failure here leaves a duplicate, and the
 * message has to say so — `afterwards` is the sentence naming what is
 * already on disk and what to delete by hand.
 */
export async function removeFile(
	path: string,
	afterwards: string,
): Promise<void> {
	await unlink(path).catch((error: unknown) => {
		throw new ForgeError(`cannot remove: ${messageOf(error)}; ${afterwards}`, {
			file: path,
		});
	});
}

export async function readYamlFile<T>(
	path: string,
	schema: ZodType<T>,
): Promise<T> {
	return parseYamlText(path, await readText(path), schema);
}

export function parseYamlText<T>(
	path: string,
	text: string,
	schema: ZodType<T>,
): T {
	let data: unknown;
	try {
		data = parse(text);
	} catch (error) {
		throw new ForgeError(`invalid YAML: ${messageOf(error)}`, {
			file: path,
		});
	}
	const result = schema.safeParse(data);
	if (!result.success) {
		throw new ForgeError(
			`does not match schema: ${result.error.issues.map((issue) => describeIssue(issue, data)).join("; ")}`,
			{ file: path },
		);
	}
	return result.data;
}

export async function writeYamlFile(
	path: string,
	data: unknown,
): Promise<void> {
	await writeText(path, stringify(data, { lineWidth: 0 }));
}

export async function readFeature(forgeDirectory: string): Promise<Feature> {
	return readYamlFile(forgePaths(forgeDirectory).feature, FeatureSchema);
}

/**
 * The same read as `readFeature`, but `undefined` instead of a throw when
 * no feature has been written yet — for `describe`, which must tell "no
 * feature here" apart from "a feature that must not be overwritten". A
 * file that exists but is unreadable or invalid still throws: silently
 * treating it as absent is how reviewed work gets destroyed.
 */
export async function readFeatureIfPresent(
	forgeDirectory: string,
): Promise<Feature | undefined> {
	const path = forgePaths(forgeDirectory).feature;
	if (!(await exists(path))) return undefined;
	return readYamlFile(path, FeatureSchema);
}

export async function writeFeature(
	forgeDirectory: string,
	feature: Feature,
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDirectory).feature, feature);
}

export async function readScenarios(
	forgeDirectory: string,
): Promise<Scenario[]> {
	const path = forgePaths(forgeDirectory).scenarios;
	if (!(await exists(path))) return [];
	return readYamlFile(path, z.array(ScenarioSchema));
}

export async function writeScenarios(
	forgeDirectory: string,
	scenarios: Scenario[],
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDirectory).scenarios, scenarios);
}

function casesPath(forgeDirectory: string, scenarioId: string): string {
	return join(forgePaths(forgeDirectory).casesDir, `${scenarioId}.yaml`);
}

export async function readCases(
	forgeDirectory: string,
	scenarioId: string,
): Promise<Case[]> {
	const path = casesPath(forgeDirectory, scenarioId);
	if (!(await exists(path))) return [];
	return readYamlFile(path, z.array(CaseSchema));
}

export async function writeCases(
	forgeDirectory: string,
	scenarioId: string,
	cases: Case[],
): Promise<void> {
	await writeYamlFile(casesPath(forgeDirectory, scenarioId), cases);
}

export async function listCaseScenarios(
	forgeDirectory: string,
): Promise<string[]> {
	const directory = forgePaths(forgeDirectory).casesDir;
	const names = await readdir(directory).catch(() => [] as string[]);
	return names
		.filter((fileName) => fileName.endsWith(".yaml"))
		.map((fileName) => basename(fileName, ".yaml"))
		.sort();
}

/**
 * A cheap signature of one cases file's on-disk state: its size and last
 * modification time, or `null` when the file does not exist. `forge
 * review` snapshots this for every file it reads, and compares again just
 * before writing back, to tell a file removed or replaced by someone else
 * during the pass from one still exactly as it was read (measured
 * 2026-09-28: the file it is about to overwrite may have been removed
 * *and recreated* with different content while a person was answering
 * questions about the old one — existence alone missed that case).
 */
export interface CaseFileFingerprint {
	modifiedAtInMilliseconds: number;
	sizeInBytes: number;
}

export async function caseFileFingerprint(
	forgeDirectory: string,
	scenarioId: string,
): Promise<CaseFileFingerprint | null> {
	return stat(casesPath(forgeDirectory, scenarioId)).then(
		(information) => ({
			modifiedAtInMilliseconds: information.mtimeMs,
			sizeInBytes: information.size,
		}),
		() => null,
	);
}

/** A cases file as `llm-tests-forge review` read it: its cases and the fingerprint of the file they came from. */
export interface ReadCaseFile {
	cases: Case[];
	fingerprint: CaseFileFingerprint;
}

/**
 * Reads one cases file together with its fingerprint, or `null` when the
 * file does not exist. The fingerprint is taken first: a file changed
 * between the two reads then carries a fingerprint older than its content,
 * which the write-back guard reads as changed and refuses — never the other
 * way round, a file whose content is older than the fingerprint it passes.
 */
export async function readCaseFile(
	forgeDirectory: string,
	scenarioId: string,
): Promise<ReadCaseFile | null> {
	const fingerprint = await caseFileFingerprint(forgeDirectory, scenarioId);
	if (fingerprint === null) return null;
	return { cases: await readCases(forgeDirectory, scenarioId), fingerprint };
}

/** A YAML line with its comment starting at column 34, as the example lines up. */
const withComment = (text: string, comment: string): string =>
	`${text.padEnd(34)}# ${comment}`;

/**
 * The suite.yaml the "not found" error shows, in the project's language
 * when there is one (python otherwise, and for `other`): the kinds comment
 * lists the rest either way.
 */
export function suiteExample(language: Language | undefined): string {
	const kind =
		language === undefined || language === "other" ? "python" : language;
	return [
		"target:",
		withComment(
			`  kind: ${kind}`,
			"python | javascript | typescript | elixir | ruby | rust | go | exec | http",
		),
		withComment(
			`  entry: ${DEFAULT_ENTRY[kind]}`,
			"optional: the shim emit writes next to this file",
		),
		...(kind === "python"
			? [
					withComment(
						"  python: .venv/bin/python",
						"optional: interpreter that can import your application",
					),
				]
			: []),
		"  models: [anthropic/claude-haiku-4-5]",
		"judges: [google/gemini-3.5-flash]",
		"repeat: 2",
		withComment(
			"include: []",
			"scenario ids; empty means every approved scenario",
		),
	].join("\n");
}

export async function readSuite(
	forgeDirectory: string,
	language?: Language,
): Promise<Suite> {
	const path = forgePaths(forgeDirectory).suite;
	if (!(await exists(path)))
		throw new ForgeError(
			`suite.yaml not found; write one like:\n${suiteExample(language)}`,
			{
				file: path,
			},
		);
	return readYamlFile(path, SuiteSchema);
}

/**
 * The same read as `readSuite`, but `null` when no suite.yaml has been
 * written yet — for `move`, which rewrites `suite.include` when the suite
 * names the scenario being renamed and must not invent a suite when there
 * is none. The text comes back beside the parsed suite because the
 * rewrite works on the document, not on the object (see
 * `rewriteSuiteInclude`). A file that exists but is unreadable or invalid
 * still throws.
 */
export async function readSuiteIfPresent(
	forgeDirectory: string,
): Promise<{ suite: Suite; text: string } | null> {
	const path = forgePaths(forgeDirectory).suite;
	if (!(await exists(path))) return null;
	const text = await readText(path);
	return { suite: parseYamlText(path, text, SuiteSchema), text };
}

/**
 * The text of suite.yaml with every `include` entry equal to `from`
 * rewritten as `to`, through the document rather than through
 * `writeSuite`: suite.yaml is the one forge file the person writes by
 * hand, and re-serialising the parsed object would drop every comment and
 * turn every flow list into a block. Only the scalars are touched;
 * comments, key order and flow style survive. Spacing is the printer's,
 * not the person's (`[a,b]`, a comment's indent and a 4-space block indent
 * come back normalised), which is the trade the `yaml` Document API makes.
 *
 * `occurrences` is how many entries the parsed suite holds for `from`. An
 * entry reached through an alias (`include: *shared`, or `[*old, keep]`)
 * is not a scalar of the sequence, so it is not rewritten — and the
 * parsed suite, which resolves aliases, would still say the rename
 * happened. Refused by name rather than reported as done. Pure, so the
 * caller can compute it before its first write.
 */
export function rewriteSuiteInclude(options: {
	path: string;
	text: string;
	from: string;
	to: string;
	occurrences: number;
}): string {
	const { path, text, from, to: replacement, occurrences } = options;
	const document = parseDocument(text);
	// Stryker disable next-line BooleanLiteral: keepScalar only changes what a scalar value comes back as, and a scalar include is not a sequence either way.
	const include = document.get("include", true);
	let rewritten = 0;
	// Stryker disable next-line ArrayDeclaration: an element added to the empty list would be a string, which isScalar refuses, so nothing more is rewritten.
	for (const item of isSeq(include) ? include.items : [])
		if (isScalar(item) && item.value === from) {
			item.value = replacement;
			rewritten += 1;
		}
	if (rewritten !== occurrences)
		throw new ForgeError(
			`suite.include names "${from}" ${occurrences} time(s) but only ${rewritten} can be rewritten in place: the rest come through a YAML alias; edit suite.yaml by hand`,
			{ file: path, id: from },
		);
	return document.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

/**
 * Records `version` as suite.yaml's `forge_version` and reads a legacy
 * `target.kind: promptfoo-python` as `python`, through the document so the
 * person's comments survive (see `rewriteSuiteInclude`). A stamp already at
 * or above `version` stays: an older forge must not claim a suite that a
 * newer one wrote. True when the file was written; false when there was
 * nothing to change or no suite.yaml.
 */
export async function stampSuite(
	forgeDirectory: string,
	version: string,
): Promise<boolean> {
	const present = await readSuiteIfPresent(forgeDirectory);
	if (present === null) return false;
	const document = parseDocument(present.text);
	const existing = document.get("forge_version");
	const keepExisting =
		typeof existing === "string" && !isHigherVersion(version, existing);
	const stamp = keepExisting ? existing : version;
	const legacyKind = document.getIn(["target", "kind"]) === "promptfoo-python";
	if (existing === stamp && !legacyKind) return false;
	const contents = document.contents;
	// A stamp added for the first time goes first, where a reader sees it;
	// an existing one is replaced where it stands.
	if (document.has("forge_version") || !isMap(contents)) {
		document.set("forge_version", stamp);
		const node = document.get("forge_version", true);
		// An empty stamp was written `""`: the new one is a plain scalar.
		// Stryker disable next-line StringLiteral: yaml writes a scalar with an empty type in its default style, plain for any one-line text, and the stamp is FORGE_VERSION (the one caller, src/cli/main.ts, passes it; the version test "is a SemVer version" guards its shape) or an existing stamp that parses as semver (probed: only a text holding a line break prints differently).
		if (isScalar(node)) node.type = "PLAIN";
	} else {
		const stampKey = new Scalar("forge_version");
		// A header comment stays at the top of the file, above the stamp,
		// whatever shape the first key has. `slice` reaches the first entry
		// with no guard; an empty map, which SuiteSchema's required
		// `target` rules out, would only skip it.
		for (const { key } of contents.items.slice(0, 1)) {
			stampKey.commentBefore = key.commentBefore;
			key.commentBefore = undefined;
		}
		const entries: YAMLMap<unknown, unknown> = contents;
		entries.items.unshift(new Pair(stampKey, new Scalar(stamp)));
	}
	if (legacyKind) document.setIn(["target", "kind"], "python");
	await writeText(
		forgePaths(forgeDirectory).suite,
		document.toString({ flowCollectionPadding: false, lineWidth: 0 }),
	);
	return true;
}

export async function writeSuite(
	forgeDirectory: string,
	suite: Suite,
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDirectory).suite, suite);
}

export async function readAllCases(
	forgeDirectory: string,
): Promise<Map<string, Case[]>> {
	const out = new Map<string, Case[]>();
	for (const id of await listCaseScenarios(forgeDirectory))
		out.set(id, await readCases(forgeDirectory, id));
	return out;
}
