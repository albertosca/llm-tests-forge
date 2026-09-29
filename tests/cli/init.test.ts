import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { main } from "../../src/cli/main";
import { AGENTS_END, AGENTS_START } from "../../src/core/agents-block";
import { projectWith } from "../helpers/project";

async function directoryWith(files: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-init-"));
	for (const file of files) await writeFile(join(directory, file), "");
	return directory;
}

async function runInit(
	cwd: string,
	argv: string[] = [],
): Promise<{ status: number; lines: string[] }> {
	const lines: string[] = [];
	const status = await main(["init", ...argv], {
		cwd,
		env: {},
		stdin: async () => "",
		stdout: (line) => lines.push(line),
	});
	return { status, lines };
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe("init through main()", () => {
	test("writes forge.yaml from the manifest and the AGENTS.md block", async () => {
		const directory = await directoryWith(["pyproject.toml"]);
		const { status, lines } = await runInit(directory);
		expect(status).toBe(0);
		expect(lines).toEqual([
			"init: wrote forge.yaml (language: python, from pyproject.toml)",
			"init: wrote the llm-tests-forge block in AGENTS.md",
		]);
		const project = parse(
			await readFile(join(directory, "forge.yaml"), "utf8"),
		);
		expect(project.language).toBe("python");
		expect(project.suites).toEqual([]);
		const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
		expect(agents).toStartWith(AGENTS_START);
		expect(agents).toContain(AGENTS_END);
	});

	test("--language overrides the manifest", async () => {
		const directory = await directoryWith(["pyproject.toml"]);
		const { lines } = await runInit(directory, ["--language", "go"]);
		expect(lines[0]).toBe(
			"init: wrote forge.yaml (language: go, from --language)",
		);
		expect(
			parse(await readFile(join(directory, "forge.yaml"), "utf8")).language,
		).toBe("go");
	});

	test("--language with a language that does not exist exits 2 and names the valid ones", async () => {
		const directory = await directoryWith([]);
		const { status, lines } = await runInit(directory, ["--language", "cobol"]);
		expect(status).toBe(2);
		expect(lines[0]).toContain('"cobol"');
		expect(lines[0]).toContain("python, javascript, typescript, elixir");
		expect(await exists(join(directory, "forge.yaml"))).toBe(false);
		expect(await exists(join(directory, "AGENTS.md"))).toBe(false);
	});

	test("no manifest writes language: other and says so", async () => {
		const directory = await directoryWith([]);
		const { lines } = await runInit(directory);
		expect(lines[0]).toBe(
			"init: wrote forge.yaml (language: other, no manifest found; pass --language or edit forge.yaml)",
		);
		expect(
			parse(await readFile(join(directory, "forge.yaml"), "utf8")).language,
		).toBe("other");
	});

	test("a CLAUDE.md that does not mention AGENTS.md gets a hint and is left byte-identical; one that does gets none", async () => {
		const silent = await directoryWith(["go.mod"]);
		await writeFile(join(silent, "CLAUDE.md"), "# Notes\n");
		const { lines } = await runInit(silent);
		expect(lines).toContain(
			'init: CLAUDE.md does not import AGENTS.md; add the line "@AGENTS.md" to it so Claude Code reads the block',
		);
		expect(await readFile(join(silent, "CLAUDE.md"), "utf8")).toBe("# Notes\n");

		const importing = await directoryWith(["go.mod"]);
		await writeFile(join(importing, "CLAUDE.md"), "@AGENTS.md\n");
		const second = await runInit(importing);
		expect(second.lines.join("\n")).not.toContain("CLAUDE.md");
		expect(await readFile(join(importing, "CLAUDE.md"), "utf8")).toBe(
			"@AGENTS.md\n",
		);
	});

	test("a second init leaves forge.yaml byte-identical and updates the block", async () => {
		const directory = await directoryWith(["Cargo.toml"]);
		await runInit(directory);
		const before = await readFile(join(directory, "forge.yaml"), "utf8");
		const { status, lines } = await runInit(directory, ["--language", "go"]);
		expect(status).toBe(0);
		expect(lines).toEqual([
			"init: forge.yaml exists, left untouched",
			"init: updated the llm-tests-forge block in AGENTS.md",
		]);
		expect(await readFile(join(directory, "forge.yaml"), "utf8")).toBe(before);
	});

	test("an AGENTS.md with text but no block gets the block appended and keeps the text", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(join(directory, "AGENTS.md"), "# Agents\n");
		const { lines } = await runInit(directory);
		expect(lines[1]).toBe("init: wrote the llm-tests-forge block in AGENTS.md");
		expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toStartWith(
			`# Agents\n\n${AGENTS_START}`,
		);
	});

	test("from a subdirectory that has no .forge, init works at the project root", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: []\n",
		);
		const subdirectory = join(root, "src", "deep");
		await mkdir(subdirectory, { recursive: true });
		const { status, lines } = await runInit(subdirectory);
		expect(status).toBe(0);
		expect(lines[0]).toBe("init: forge.yaml exists, left untouched");
		expect(await exists(join(root, "AGENTS.md"))).toBe(true);
		expect(await exists(join(subdirectory, "AGENTS.md"))).toBe(false);
		expect(await exists(join(subdirectory, "forge.yaml"))).toBe(false);
	});

	test("a malformed forge.yaml is left untouched and does not stop the AGENTS.md block", async () => {
		const root = await projectWith("version: 1\nlanguage: cobol\n");
		const { status, lines } = await runInit(root);
		expect(status).toBe(0);
		expect(lines[0]).toBe("init: forge.yaml exists, left untouched");
		expect(await readFile(join(root, "forge.yaml"), "utf8")).toBe(
			"version: 1\nlanguage: cobol\n",
		);
		expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
			AGENTS_START,
		);
	});

	test("broken markers in AGENTS.md are refused before anything is written", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(join(directory, "AGENTS.md"), `a\n${AGENTS_START}\n`);
		const { status, lines } = await runInit(directory);
		expect(status).toBe(1);
		expect(lines[0]).toContain(
			"AGENTS.md line 2 opens the llm-tests-forge block and nothing closes it",
		);
		expect(await exists(join(directory, "forge.yaml"))).toBe(false);
	});

	test("--suite and stray words are usage errors", async () => {
		const directory = await directoryWith([]);
		const withSuite = await runInit(directory, ["--suite", "evals/a"]);
		expect(withSuite.status).toBe(2);
		expect(withSuite.lines[0]).toBe(
			"error: init works at the project root and does not take --suite",
		);
		const withWord = await runInit(directory, ["extra"]);
		expect(withWord.status).toBe(2);
		expect(await exists(join(directory, "forge.yaml"))).toBe(false);
	});

	test("init does not stamp or create a suite", async () => {
		const directory = await directoryWith(["go.mod"]);
		await runInit(directory);
		expect(await exists(join(directory, ".forge"))).toBe(false);
	});
});
