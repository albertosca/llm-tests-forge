import {
	access,
	mkdir,
	readdir,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { isScalar, isSeq, parse, parseDocument, stringify } from "yaml";
import type { core, ZodType } from "zod";
import { z } from "zod";
import { ForgeError } from "./errors";
import {
	type Case,
	CaseSchema,
	type Feature,
	FeatureSchema,
	type Scenario,
	ScenarioSchema,
	type Suite,
	SuiteSchema,
} from "./schemas";

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

export function forgePaths(forgeDir: string): ForgePaths {
	return {
		root: forgeDir,
		feature: join(forgeDir, "feature.yaml"),
		scenarios: join(forgeDir, "scenarios.yaml"),
		casesDir: join(forgeDir, "cases"),
		suite: join(forgeDir, "suite.yaml"),
		usage: join(forgeDir, "usage.jsonl"),
		failuresDir: join(forgeDir, "failures"),
		promptfooConfig: join(forgeDir, "promptfooconfig.yaml"),
		casesJsonl: join(forgeDir, "cases.jsonl"),
		reportMd: join(forgeDir, "report.md"),
		reportJson: join(forgeDir, "report.json"),
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function hasCode(e: unknown): e is { code: string } {
	return (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		typeof (e as { code: unknown }).code === "string"
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
export function readFailure(e: unknown): string {
	const code = hasCode(e) ? e.code : undefined;
	switch (code) {
		case "ENOENT":
			return "file not found";
		case "EISDIR":
			return "is a directory, expected a file";
		case "EACCES":
		case "EPERM":
			return "permission denied";
		default:
			return `cannot read: ${(e as Error).message}`;
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
	return readFile(path, "utf8").catch((e: unknown) => {
		throw new ForgeError(readFailure(e), { file: path });
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
		.catch((e: unknown) => {
			throw new ForgeError(`cannot write: ${(e as Error).message}`, {
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
	await unlink(path).catch((e: unknown) => {
		throw new ForgeError(
			`cannot remove: ${(e as Error).message}; ${afterwards}`,
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

function parseYamlText<T>(path: string, text: string, schema: ZodType<T>): T {
	let data: unknown;
	try {
		data = parse(text);
	} catch (e) {
		throw new ForgeError(`invalid YAML: ${(e as Error).message}`, {
			file: path,
		});
	}
	const result = schema.safeParse(data);
	if (!result.success) {
		throw new ForgeError(
			`does not match schema: ${result.error.issues.map((i) => describeIssue(i, data)).join("; ")}`,
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

export async function readFeature(forgeDir: string): Promise<Feature> {
	return readYamlFile(forgePaths(forgeDir).feature, FeatureSchema);
}

/**
 * The same read as `readFeature`, but `undefined` instead of a throw when
 * no feature has been written yet — for `describe`, which must tell "no
 * feature here" apart from "a feature that must not be overwritten". A
 * file that exists but is unreadable or invalid still throws: silently
 * treating it as absent is how reviewed work gets destroyed.
 */
export async function readFeatureIfPresent(
	forgeDir: string,
): Promise<Feature | undefined> {
	const path = forgePaths(forgeDir).feature;
	if (!(await exists(path))) return undefined;
	return readYamlFile(path, FeatureSchema);
}

export async function writeFeature(
	forgeDir: string,
	feature: Feature,
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDir).feature, feature);
}

export async function readScenarios(forgeDir: string): Promise<Scenario[]> {
	const path = forgePaths(forgeDir).scenarios;
	if (!(await exists(path))) return [];
	return readYamlFile(path, z.array(ScenarioSchema));
}

export async function writeScenarios(
	forgeDir: string,
	scenarios: Scenario[],
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDir).scenarios, scenarios);
}

function casesPath(forgeDir: string, scenarioId: string): string {
	return join(forgePaths(forgeDir).casesDir, `${scenarioId}.yaml`);
}

export async function readCases(
	forgeDir: string,
	scenarioId: string,
): Promise<Case[]> {
	const path = casesPath(forgeDir, scenarioId);
	if (!(await exists(path))) return [];
	return readYamlFile(path, z.array(CaseSchema));
}

export async function writeCases(
	forgeDir: string,
	scenarioId: string,
	cases: Case[],
): Promise<void> {
	await writeYamlFile(casesPath(forgeDir, scenarioId), cases);
}

export async function listCaseScenarios(forgeDir: string): Promise<string[]> {
	const dir = forgePaths(forgeDir).casesDir;
	const names = await readdir(dir).catch(() => [] as string[]);
	return names
		.filter((n) => n.endsWith(".yaml"))
		.map((n) => basename(n, ".yaml"))
		.sort();
}

export const SUITE_EXAMPLE = `target:
  kind: promptfoo-python
  entry: forge_target.py          # the shim emit writes next to this file
  python: .venv/bin/python        # optional: interpreter that can import your application
  models: [anthropic/claude-haiku-4-5]
judges: [google/gemini-3.5-flash]
repeat: 2
include: []                        # scenario ids; empty means every approved scenario`;

export async function readSuite(forgeDir: string): Promise<Suite> {
	const path = forgePaths(forgeDir).suite;
	if (!(await exists(path)))
		throw new ForgeError(
			`suite.yaml not found; write one like:\n${SUITE_EXAMPLE}`,
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
	forgeDir: string,
): Promise<{ suite: Suite; text: string } | null> {
	const path = forgePaths(forgeDir).suite;
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
 * not the person's (`[a,b]` and a comment's indent come back normalised),
 * which is the trade the `yaml` Document API makes.
 *
 * `occurrences` is how many entries the parsed suite holds for `from`. An
 * entry reached through an alias (`include: *shared`, or `[*old, keep]`)
 * is not a scalar of the sequence, so it is not rewritten — and the
 * parsed suite, which resolves aliases, would still say the rename
 * happened. Refused by name rather than reported as done. Pure, so the
 * caller can compute it before its first write.
 */
export function rewriteSuiteInclude(args: {
	path: string;
	text: string;
	from: string;
	to: string;
	occurrences: number;
}): string {
	const { path, text, from, to, occurrences } = args;
	const doc = parseDocument(text);
	const include = doc.get("include", true);
	let rewritten = 0;
	for (const item of isSeq(include) ? include.items : [])
		if (isScalar(item) && item.value === from) {
			item.value = to;
			rewritten += 1;
		}
	if (rewritten !== occurrences)
		throw new ForgeError(
			`suite.include names "${from}" ${occurrences} time(s) but only ${rewritten} can be rewritten in place: the rest come through a YAML alias; edit suite.yaml by hand`,
			{ file: path, id: from },
		);
	return doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
}

export async function writeSuite(
	forgeDir: string,
	suite: Suite,
): Promise<void> {
	await writeYamlFile(forgePaths(forgeDir).suite, suite);
}

export async function readAllCases(
	forgeDir: string,
): Promise<Map<string, Case[]>> {
	const out = new Map<string, Case[]>();
	for (const id of await listCaseScenarios(forgeDir))
		out.set(id, await readCases(forgeDir, id));
	return out;
}
