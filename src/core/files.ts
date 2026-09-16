import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
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
 * `estimate.ts`'s `promptTokensFor`, which reads a second file outside
 * `readYamlFile` and needs the same causes.
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

export async function readYamlFile<T>(
	path: string,
	schema: ZodType<T>,
): Promise<T> {
	const text = await readFile(path, "utf8").catch((e: unknown) => {
		throw new ForgeError(readFailure(e), { file: path });
	});
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
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, stringify(data, { lineWidth: 0 }), "utf8");
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
