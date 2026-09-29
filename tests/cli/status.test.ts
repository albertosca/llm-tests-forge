import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main";
import { FORGE_VERSION } from "../../src/core/version";
import { projectWith } from "../helpers/project";

const EXAMPLE = "examples/moonlighter-extract-questions/.forge";

async function runStatus(
	cwd: string,
	argv: string[] = ["status"],
): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const code = await main(argv, {
		cwd,
		env: {},
		stdin: async () => "",
		stdout: (line) => lines.push(line),
	});
	return { code, lines };
}

async function copyExample(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await cp(EXAMPLE, join(directory, ".forge"), { recursive: true });
}

async function exampleDate(directory: string): Promise<string> {
	const report = JSON.parse(
		await readFile(join(directory, ".forge", "report.json"), "utf8"),
	);
	return report.generatedAt.slice(0, 10);
}

async function projectWithTwoSuites(): Promise<string> {
	const root = await projectWith(
		'version: 1\nlanguage: python\nsuites: [evals/a, evals/gone, "../x"]\n',
	);
	await copyExample(join(root, "evals", "a"));
	return root;
}

describe("status through main()", () => {
	test("prints one line per suite, then one per bad entry, and exits 0", async () => {
		const root = await projectWithTwoSuites();
		const date = await exampleDate(join(root, "evals", "a"));
		const { code, lines } = await runStatus(root);
		expect(code).toBe(0);
		expect(lines).toEqual([
			`evals/a   extract-job-application-questions   14 scenarios approved, 0 pending · 42 cases approved, 0 pending · last run 67.9% (${date})`,
			"evals/gone   missing",
			'forge.yaml: suite "../x" climbs out of the project',
		]);
	});

	test("--json prints the statuses and the problems as one indented document", async () => {
		const root = await projectWithTwoSuites();
		const date = await exampleDate(join(root, "evals", "a"));
		const { code, lines } = await runStatus(root, ["status", "--json"]);
		expect(code).toBe(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith('{\n  "suites": [');
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			suites: [
				{
					entry: "evals/a",
					state: "ok",
					feature: "extract-job-application-questions",
					featureStatus: "approved",
					scenarios: { approved: 14, pending: 0, rejected: 0 },
					cases: { approved: 42, pending: 0 },
					lastRun: { passRate: 0.6786, date },
					warning: null,
				},
				{ entry: "evals/gone", state: "missing" },
			],
			problems: [
				{ entry: "../x", reason: 'suite "../x" climbs out of the project' },
			],
		});
	});

	test('outside a project, a .forge here is reported as the suite "."', async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-status-"));
		await copyExample(directory);
		const date = await exampleDate(directory);
		const { code, lines } = await runStatus(directory);
		expect(code).toBe(0);
		expect(lines).toEqual([
			`.   extract-job-application-questions   14 scenarios approved, 0 pending · 42 cases approved, 0 pending · last run 67.9% (${date})`,
		]);
	});

	test("with no project and no .forge, says how to start one and exits 0", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-status-"));
		const { code, lines } = await runStatus(directory);
		expect(code).toBe(0);
		expect(lines).toEqual([
			"no llm-tests-forge project here; run llm-tests-forge init to start one",
		]);
	});

	test("--json with no project and no .forge prints empty lists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-status-"));
		const { code, lines } = await runStatus(directory, ["status", "--json"]);
		expect(code).toBe(0);
		expect(JSON.parse(lines[0] ?? "")).toEqual({ suites: [], problems: [] });
	});

	test("a forge.yaml that does not parse stops with its name and exit 1", async () => {
		const root = await projectWith("version: 1\nlanguage: [unclosed\n");
		const { code, lines } = await runStatus(root);
		expect(code).toBe(1);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("error: invalid YAML: ");
		expect(lines[0]).toContain(join(root, "forge.yaml"));
	});

	test("a project with no suites says how to start one in the human form and lists nothing in --json", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: []\n",
		);
		const human = await runStatus(root);
		expect(human.code).toBe(0);
		expect(human.lines).toEqual([
			`no suites registered in ${join(root, "forge.yaml")}; run llm-tests-forge describe in a new directory to start one`,
		]);
		const machine = await runStatus(root, ["status", "--json"]);
		expect(machine.code).toBe(0);
		expect(JSON.parse(machine.lines[0] ?? "")).toEqual({
			suites: [],
			problems: [],
		});
	});

	test("takes no positional argument", async () => {
		const root = await projectWithTwoSuites();
		const { code, lines } = await runStatus(root, ["status", "evals/a"]);
		expect(code).toBe(2);
		expect(lines[0]).toStartWith(
			'error: status takes no argument, got "evals/a"',
		);
	});

	test("run from inside an outdated suite, it neither prints the per-verb warning nor stamps, and --json stays parseable", async () => {
		const root = await projectWithTwoSuites();
		const suiteDirectory = join(root, "evals", "a");
		const suiteFile = join(suiteDirectory, ".forge", "suite.yaml");
		const outdated = (await readFile(suiteFile, "utf8")).replace(
			"forge_version: 0.1.0",
			"forge_version: 0.0.1",
		);
		await writeFile(suiteFile, outdated);
		const { code, lines } = await runStatus(suiteDirectory, [
			"status",
			"--json",
		]);
		expect(code).toBe(0);
		expect(lines).toHaveLength(1);
		const document = JSON.parse(lines[0] ?? "");
		expect(document.suites[0].warning).toBe(
			`warning: this suite was written by llm-tests-forge 0.0.1; installed is ${FORGE_VERSION}`,
		);
		expect(await readFile(suiteFile, "utf8")).toBe(outdated);
	});
});
