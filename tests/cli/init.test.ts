import { describe, expect, test } from "bun:test";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
	AGENTS_END,
	AGENTS_START,
	agentsBlock,
} from "../../src/core/agents-block";
import { mainWithTestDefaults as main } from "../helpers/main";
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

	test("an AGENTS.md that is the same file as CLAUDE.md (a symlink either way) gets no hint to import itself", async () => {
		for (const linkName of ["AGENTS.md", "CLAUDE.md"]) {
			const directory = await directoryWith(["go.mod"]);
			const target = linkName === "AGENTS.md" ? "CLAUDE.md" : "AGENTS.md";
			await writeFile(join(directory, target), "# Notes\n");
			await symlink(target, join(directory, linkName));
			const { status, lines } = await runInit(directory);
			expect({ linkName, status }).toEqual({ linkName, status: 0 });
			expect(lines.join("\n")).not.toContain("does not import");
			// The block went into the one file, through the link.
			expect(await readFile(join(directory, "CLAUDE.md"), "utf8")).toContain(
				AGENTS_START,
			);
		}
	});

	test("a hard link between them is broken by the atomic write, so CLAUDE.md is a separate file again and gets the hint", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(join(directory, "CLAUDE.md"), "# Notes\n");
		await link(join(directory, "CLAUDE.md"), join(directory, "AGENTS.md"));
		const { lines } = await runInit(directory);
		expect(lines).toContain(
			'init: CLAUDE.md does not import AGENTS.md; add the line "@AGENTS.md" to it so Claude Code reads the block',
		);
		expect(await readFile(join(directory, "CLAUDE.md"), "utf8")).toBe(
			"# Notes\n",
		);
	});

	test("a second init leaves forge.yaml byte-identical and updates the block", async () => {
		const directory = await directoryWith(["Cargo.toml"]);
		await runInit(directory);
		const before = await readFile(join(directory, "forge.yaml"), "utf8");
		const { status, lines } = await runInit(directory, ["--language", "go"]);
		expect(status).toBe(0);
		expect(lines).toEqual([
			"init: forge.yaml exists, left untouched; --language go ignored",
			"init: updated the llm-tests-forge block in AGENTS.md",
		]);
		expect(await readFile(join(directory, "forge.yaml"), "utf8")).toBe(before);
	});

	test("init without --language on an existing project does not mention the flag", async () => {
		const directory = await directoryWith(["Cargo.toml"]);
		await runInit(directory);
		const { lines } = await runInit(directory);
		expect(lines[0]).toBe("init: forge.yaml exists, left untouched");
	});

	test("init runs inside a project that has no .forge directory", async () => {
		const root = await projectWith("version: 1\nlanguage: go\nsuites: []\n");
		const { status, lines } = await runInit(root);
		expect(status).toBe(0);
		expect(lines[0]).toBe("init: forge.yaml exists, left untouched");
		expect(await exists(join(root, ".forge"))).toBe(false);
	});

	test("an AGENTS.md with CRLF endings keeps CRLF in the text it appends", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(
			join(directory, "AGENTS.md"),
			"# Agents\r\n\r\nBe nice.\r\n",
		);
		await runInit(directory);
		const written = await readFile(join(directory, "AGENTS.md"), "utf8");
		expect(written).toBe(
			`# Agents\r\n\r\nBe nice.\r\n\r\n${agentsBlock().split("\n").join("\r\n")}\r\n`,
		);
		expect(written.replaceAll("\r\n", "")).not.toContain("\n");
	});

	test("an AGENTS.md with CRLF endings keeps CRLF in the block it replaces and around it", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(
			join(directory, "AGENTS.md"),
			`# Agents\r\n${AGENTS_START}\r\nold\r\n${AGENTS_END}\r\nAfter.\r\n`,
		);
		const { lines } = await runInit(directory);
		expect(lines[1]).toBe(
			"init: updated the llm-tests-forge block in AGENTS.md",
		);
		expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
			`# Agents\r\n${agentsBlock().split("\n").join("\r\n")}\r\nAfter.\r\n`,
		);
	});

	test("markers quoted inside a fenced block are not the block: text is appended and 'wrote' is said", async () => {
		const directory = await directoryWith(["go.mod"]);
		const quoted = `# Agents\n\`\`\`\n${AGENTS_START}\nold\n${AGENTS_END}\n\`\`\`\n`;
		await writeFile(join(directory, "AGENTS.md"), quoted);
		const { status, lines } = await runInit(directory);
		expect(status).toBe(0);
		expect(lines[1]).toBe("init: wrote the llm-tests-forge block in AGENTS.md");
		expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
			`${quoted}\n${agentsBlock()}\n`,
		);
	});

	test("an inline mention of the start marker says 'wrote', not 'updated'", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(
			join(directory, "AGENTS.md"),
			`Do not delete ${AGENTS_START} by hand.\n`,
		);
		const { lines } = await runInit(directory);
		expect(lines[1]).toBe("init: wrote the llm-tests-forge block in AGENTS.md");
	});

	test("init writes AGENTS.md before forge.yaml: a failed AGENTS.md write leaves no forge.yaml", async () => {
		const directory = await directoryWith(["go.mod"]);
		await mkdir(join(directory, "AGENTS.md"));
		const { status, lines } = await runInit(directory);
		expect(status).toBe(1);
		expect(lines[0]).toContain("AGENTS.md");
		expect(await exists(join(directory, "forge.yaml"))).toBe(false);
	});

	test("a read-only AGENTS.md fails the write and leaves no forge.yaml behind", async () => {
		if (process.getuid?.() === 0) return;
		const directory = await directoryWith(["go.mod"]);
		await writeFile(join(directory, "AGENTS.md"), "# Agents\n");
		await chmod(join(directory, "AGENTS.md"), 0o444);
		try {
			const { status, lines } = await runInit(directory);
			expect(status).toBe(1);
			expect(lines[0]).toContain("AGENTS.md");
			expect(await exists(join(directory, "forge.yaml"))).toBe(false);
		} finally {
			await chmod(join(directory, "AGENTS.md"), 0o644);
		}
	});

	test("init with an unclosed fence before a real pair, run twice, keeps exactly one block", async () => {
		const directory = await directoryWith(["go.mod"]);
		await writeFile(
			join(directory, "AGENTS.md"),
			`# t\n\`\`\`\ncode\n${AGENTS_START}\nold\n${AGENTS_END}\n`,
		);
		const first = await runInit(directory);
		expect(first.lines[1]).toBe(
			"init: updated the llm-tests-forge block in AGENTS.md",
		);
		await runInit(directory);
		expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
			`# t\n\`\`\`\ncode\n${agentsBlock()}\n`,
		);
	});

	test("a directory named like a manifest is not a manifest", async () => {
		const directory = await directoryWith([]);
		await mkdir(join(directory, "Gemfile"));
		const { lines } = await runInit(directory);
		expect(lines[0]).toContain("language: other");
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
