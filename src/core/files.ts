import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ZodType } from "zod";
import { z } from "zod";
import { ForgeError } from "./errors";
import {
	type Case,
	CaseSchema,
	type Feature,
	FeatureSchema,
	type Scenario,
	ScenarioSchema,
} from "./schemas";

export interface ForgePaths {
	root: string;
	feature: string;
	scenarios: string;
	casesDir: string;
	suite: string;
	usage: string;
	failuresDir: string;
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
	};
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

export async function readYamlFile<T>(
	path: string,
	schema: ZodType<T>,
): Promise<T> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new ForgeError("file not found", { file: path });
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
			`does not match schema: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
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
