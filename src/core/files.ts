import {
	access,
	mkdir,
	readdir,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
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
import { ForgeError } from "./errors";
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
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function hasCode(error: unknown): error is { code: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
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
			return `cannot read: ${(error as Error).message}`;
	}
}

/**
 * `does not match schema` reports each issue by its zod path, e.g.
 * `2.oracle: ...` for the third array element -- a bare index tells the
 * person nothing about which reviewed item broke. When the issue is on an
 * array element that itself carries a string `id` (every top-level forge
 * list does), name that id and the index instead of the bare number; every
 * other issue (a non-array file, or an array element without an `id`)
 * keeps the plain `path: message` form.
 */
function describeIssue(issue: core.$ZodIssue, data: unknown): string {
	const index = issue.path[0];
	const item =
		typeof index === "number" && Array.isArray(data) ? data[index] : undefined;
	const id =
		typeof item === "object" && item !== null && "id" in item
			? (item as { id: unknown }).id
			: undefined;
	if (typeof index === "number" && typeof id === "string") {
		const rest = issue.path.slice(1).join(".");
		return `item "${id}" (index ${index})${rest ? `.${rest}` : ""}: ${issue.message}`;
	}
	return `${issue.path.join(".")}: ${issue.message}`;
}

/** A read whose failure names the file and the OS's reason, as every forge read does. */
export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8").catch((error: unknown) => {
		throw new ForgeError(readFailure(error), { file: path });
	});
}

/**
 * A write whose failure names the file: a name the filesystem refuses, a
 * directory that cannot be written into, a parent that is a file. The raw
 * `ENAMETOOLONG: name too long, open '...'` used to surface with no verb
 * owning it.
 */
export async function writeText(path: string, text: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true })
		.then(() => writeFile(path, text, "utf8"))
		.catch((error: unknown) => {
			throw new ForgeError(`cannot write: ${(error as Error).message}`, {
				file: path,
			});
		});
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
		throw new ForgeError(
			`cannot remove: ${(error as Error).message}; ${afterwards}`,
			{ file: path },
		);
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
		throw new ForgeError(`invalid YAML: ${(error as Error).message}`, {
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
	const include = document.get("include", true);
	let rewritten = 0;
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
		if (isScalar(node)) node.type = "PLAIN";
	} else {
		const entries: YAMLMap<unknown, unknown> = contents;
		const stampKey = new Scalar("forge_version");
		const firstKey = entries.items[0]?.key;
		// A header comment stays at the top of the file, above the stamp.
		if (isScalar(firstKey) && firstKey.commentBefore) {
			stampKey.commentBefore = firstKey.commentBefore;
			firstKey.commentBefore = undefined;
		}
		entries.items.unshift(new Pair(stampKey, new Scalar(stamp)));
	}
	if (legacyKind) document.setIn(["target", "kind"], "python");
	await writeFile(
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
