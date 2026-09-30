import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AGENTS_END,
	AGENTS_START,
	agentsBlock,
	PER_PROJECT_INVOCATIONS,
	planAgentsBlock,
	upsertAgentsBlock,
} from "../../src/core/agents-block";

describe("the per-project invocations", () => {
	test("the AGENTS block, the guide and the plugin skill name the same four ways to call a project-local install", async () => {
		const repositoryRoot = join(import.meta.dir, "..", "..");
		const invocations = [
			"`npx llm-tests-forge`",
			"`uv run llm-tests-forge`",
			"`bundle exec llm-tests-forge`",
			"`_build/llm-tests-forge`",
		];
		const texts = {
			block: agentsBlock(),
			guide: await readFile(join(repositoryRoot, "templates/guide.md"), "utf8"),
			skill: await readFile(
				join(repositoryRoot, "plugin/skills/llm-tests-forge/SKILL.md"),
				"utf8",
			),
		};
		for (const [name, text] of Object.entries(texts))
			for (const invocation of invocations)
				expect({ name, invocation, named: text.includes(invocation) }).toEqual({
					name,
					invocation,
					named: true,
				});
		expect(texts.block.split("\n")).toContain(PER_PROJECT_INVOCATIONS);
		expect(texts.skill).toContain(PER_PROJECT_INVOCATIONS);
	});
});

describe("upsertAgentsBlock", () => {
	const block = agentsBlock();
	test("a missing file becomes the block; a file without markers gets it appended after a blank line", () => {
		expect(upsertAgentsBlock("AGENTS.md", null)).toBe(`${block}\n`);
		expect(upsertAgentsBlock("AGENTS.md", "# Agents\n\nBe nice.\n")).toBe(
			`# Agents\n\nBe nice.\n\n${block}\n`,
		);
	});
	test("an empty file becomes the block, and a file with no final newline still gets a blank line", () => {
		expect(upsertAgentsBlock("AGENTS.md", "")).toBe(`${block}\n`);
		expect(upsertAgentsBlock("AGENTS.md", "# Agents")).toBe(
			`# Agents\n\n${block}\n`,
		);
	});
	test("an existing pair is replaced in place, and the text around it survives", () => {
		const existing = `# Agents\n${AGENTS_START}\nold text\n${AGENTS_END}\nAfter.\n`;
		expect(upsertAgentsBlock("AGENTS.md", existing)).toBe(
			`# Agents\n${block}\nAfter.\n`,
		);
	});
	test("a pair is found in a file with Windows line endings", () => {
		const existing = `# Agents\r\n${AGENTS_START}\r\nold\r\n${AGENTS_END}\r\n`;
		expect(upsertAgentsBlock("AGENTS.md", existing)).toContain(
			"llm-tests-forge status",
		);
		expect(upsertAgentsBlock("AGENTS.md", existing)).not.toContain("old");
	});
	test("a lone start marker, a lone end marker, an end before the start, or a doubled marker is refused, naming the line", () => {
		expect(() =>
			upsertAgentsBlock("AGENTS.md", `a\n${AGENTS_START}\nb\n`),
		).toThrow(
			"AGENTS.md line 2 opens the llm-tests-forge block and nothing closes it",
		);
		expect(() => upsertAgentsBlock("AGENTS.md", `a\n${AGENTS_END}\n`)).toThrow(
			"AGENTS.md line 2 closes an llm-tests-forge block that was never opened",
		);
		expect(() =>
			upsertAgentsBlock("AGENTS.md", `${AGENTS_END}\n${AGENTS_START}\n`),
		).toThrow(
			"AGENTS.md line 1 closes an llm-tests-forge block that was never opened",
		);
		expect(() =>
			upsertAgentsBlock(
				"AGENTS.md",
				`${AGENTS_START}\n${AGENTS_END}\n${AGENTS_START}\n${AGENTS_END}\n`,
			),
		).toThrow(
			"AGENTS.md has 2 llm-tests-forge blocks (lines 1 and 3); keep one and run init again",
		);
	});
	test("two start markers in a row name the first one; three blocks list every line", () => {
		expect(() =>
			upsertAgentsBlock(
				"AGENTS.md",
				`${AGENTS_START}\n${AGENTS_START}\n${AGENTS_END}\n`,
			),
		).toThrow(
			"AGENTS.md line 1 opens the llm-tests-forge block and nothing closes it",
		);
		const pair = `${AGENTS_START}\n${AGENTS_END}\n`;
		expect(() => upsertAgentsBlock("AGENTS.md", pair.repeat(3))).toThrow(
			"AGENTS.md has 3 llm-tests-forge blocks (lines 1, 3 and 5); keep one and run init again",
		);
	});
	test("markers inside a ``` or ~~~ fence are neither replaced nor counted as doubled", () => {
		const quotedPair = `${AGENTS_START}\nquoted\n${AGENTS_END}\n`;
		for (const fence of ["```", "~~~"]) {
			const quoted = `${fence}\n${quotedPair}${fence}\n`;
			expect(upsertAgentsBlock("AGENTS.md", quoted)).toBe(
				`${quoted}\n${block}\n`,
			);
			const withReal = `${quoted}${AGENTS_START}\nold\n${AGENTS_END}\nEnd.\n`;
			expect(upsertAgentsBlock("AGENTS.md", withReal)).toBe(
				`${quoted}${block}\nEnd.\n`,
			);
		}
	});
	test("a fence closes only with the same character and at least as many of them", () => {
		const stillOpen = `\`\`\`\`\n~~~\n\`\`\`\n${AGENTS_END}\n\`\`\`\`\n`;
		expect(upsertAgentsBlock("AGENTS.md", stillOpen)).toBe(
			`${stillOpen}\n${block}\n`,
		);
		const closedThenReal = `~~~ text\n${AGENTS_END}\n~~~\n${AGENTS_END}\n`;
		expect(() => upsertAgentsBlock("AGENTS.md", closedThenReal)).toThrow(
			"AGENTS.md line 4 closes an llm-tests-forge block that was never opened",
		);
	});
	test("a fence still open at the end of the file is not a fence: the real pair after it is replaced, and a second run keeps one block", () => {
		const pair = `${AGENTS_START}\nold\n${AGENTS_END}\n`;
		for (const fence of ["```", "~~~"]) {
			const existing = `# t\n${fence}\ncode\n${pair}`;
			const first = planAgentsBlock("AGENTS.md", existing);
			expect(first.replaced).toBe(true);
			expect(first.text).toBe(`# t\n${fence}\ncode\n${block}\n`);
			const second = planAgentsBlock("AGENTS.md", first.text);
			expect(second.text).toBe(first.text);
			expect(second.text.split(AGENTS_START).length - 1).toBe(1);
		}
	});
	test("a stray unclosed fence later in the file does not turn off the fences that closed: the quoted pair stays and the block is appended once", () => {
		const quotedPair = `${AGENTS_START}\nquoted\n${AGENTS_END}\n`;
		for (const fence of ["```", "~~~"]) {
			const existing = `${fence}\n${quotedPair}${fence}\nText.\n${fence}\nstray\n`;
			const first = planAgentsBlock("AGENTS.md", existing);
			expect(first.replaced).toBe(false);
			expect(first.text).toBe(`${existing}\n${block}\n`);
			const second = planAgentsBlock("AGENTS.md", first.text);
			expect(second.text).toBe(first.text);
			expect(second.text.split(AGENTS_START).length - 1).toBe(2);
		}
	});
	test("a fence indented four spaces is indented code, not a fence: it does not hide the pair", () => {
		const existing = `# t\n    \`\`\`\n${AGENTS_START}\nold\n${AGENTS_END}\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`# t\n    \`\`\`\n${block}\n`);
		const threeSpaces = `   \`\`\`\n${AGENTS_START}\n${AGENTS_END}\n   \`\`\`\n`;
		expect(planAgentsBlock("AGENTS.md", threeSpaces).replaced).toBe(false);
	});
	test("appending takes the line ending of the last line, not of any line", () => {
		expect(upsertAgentsBlock("AGENTS.md", "a\nb\r\nc\n")).toBe(
			`a\nb\r\nc\n\n${block}\n`,
		);
		expect(upsertAgentsBlock("AGENTS.md", "a\r\nb\nc\r\n")).toBe(
			`a\r\nb\nc\r\n\r\n${block.split("\n").join("\r\n")}\r\n`,
		);
	});
	test("planAgentsBlock says replaced only when a real pair was found", () => {
		expect(planAgentsBlock("AGENTS.md", null).replaced).toBe(false);
		expect(
			planAgentsBlock("AGENTS.md", `see ${AGENTS_START} here\n`).replaced,
		).toBe(false);
		expect(
			planAgentsBlock("AGENTS.md", `${AGENTS_START}\n${AGENTS_END}\n`).replaced,
		).toBe(true);
	});
	test("CRLF: the replaced block and its neighbours keep CRLF byte for byte, and a last line without a newline stays without", () => {
		const crlfBlock = block.split("\n").join("\r\n");
		expect(
			upsertAgentsBlock(
				"AGENTS.md",
				`a\r\n${AGENTS_START}\r\nold\r\n${AGENTS_END}\r\nb\r\n`,
			),
		).toBe(`a\r\n${crlfBlock}\r\nb\r\n`);
		expect(
			upsertAgentsBlock("AGENTS.md", `a\r\n${AGENTS_START}\r\n${AGENTS_END}`),
		).toBe(`a\r\n${crlfBlock}`);
	});
	test("a pair indented under a list item is replaced with every line at the start marker's indentation", () => {
		const indented = (indentation: string, ending: string) =>
			block
				.split("\n")
				.map((line) => `${indentation}${line}`)
				.join(ending);
		expect(
			upsertAgentsBlock(
				"AGENTS.md",
				`- Tools:\n  ${AGENTS_START}\n  old\n    ${AGENTS_END}\n- Next.\n`,
			),
		).toBe(`- Tools:\n${indented("  ", "\n")}\n- Next.\n`);
		expect(
			upsertAgentsBlock(
				"AGENTS.md",
				`1. Tools:\r\n\t ${AGENTS_START}\r\n${AGENTS_END}\r\n`,
			),
		).toBe(`1. Tools:\r\n${indented("\t ", "\r\n")}\r\n`);
		const once = `- Tools:\n${indented("  ", "\n")}\n- Next.\n`;
		expect(upsertAgentsBlock("AGENTS.md", once)).toBe(once);
	});
	test("a pair indented four spaces, as indented code, keeps its indentation", () => {
		expect(
			upsertAgentsBlock(
				"AGENTS.md",
				`Text.\n\n    ${AGENTS_START}\n    ${AGENTS_END}`,
			),
		).toBe(
			`Text.\n\n${block
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n")}`,
		);
	});
	test("a whitespace-only file takes the block with its own line ending", () => {
		expect(upsertAgentsBlock("AGENTS.md", " \r\n")).toBe(
			`${block.split("\n").join("\r\n")}\r\n`,
		);
		expect(upsertAgentsBlock("AGENTS.md", "\r\n\r\n")).toBe(
			`${block.split("\n").join("\r\n")}\r\n`,
		);
		expect(upsertAgentsBlock("AGENTS.md", " \n")).toBe(`${block}\n`);
		expect(upsertAgentsBlock("AGENTS.md", "  ")).toBe(`${block}\n`);
		expect(planAgentsBlock("AGENTS.md", " \r\n").replaced).toBe(false);
	});
	test("a pair in a blockquote is replaced in place with the quote prefix on every line, and a second run changes nothing", () => {
		const prefixed = (prefix: string, ending: string) =>
			block
				.split("\n")
				.map((line) => `${prefix}${line}`)
				.join(ending);
		const existing = `Intro.\n\n> ${AGENTS_START}\n> old\n> ${AGENTS_END}\n\nAfter.\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`Intro.\n\n${prefixed("> ", "\n")}\n\nAfter.\n`);
		expect(upsertAgentsBlock("AGENTS.md", planned.text)).toBe(planned.text);
		// Nested, indented, without a space, and CRLF.
		const nested = `  > >${AGENTS_START}\r\n  > >${AGENTS_END}\r\n`;
		const once = upsertAgentsBlock("AGENTS.md", nested);
		expect(once).toBe(`${prefixed("  > >", "\r\n")}\r\n`);
		expect(upsertAgentsBlock("AGENTS.md", once)).toBe(once);
	});
	test("a pair whose markers stand at different blockquote depths is refused, naming both lines", () => {
		expect(() =>
			upsertAgentsBlock("AGENTS.md", `> ${AGENTS_START}\nold\n${AGENTS_END}\n`),
		).toThrow(
			"AGENTS.md line 3 closes the llm-tests-forge block opened on line 1 at a different blockquote depth",
		);
	});
	test("markers inside a fence inside a blockquote are quoted text, not the block", () => {
		const existing = `> \`\`\`\n> ${AGENTS_START}\n> ${AGENTS_END}\n> \`\`\`\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(false);
		expect(planned.text).toBe(`${existing}\n${block}\n`);
		const nested = `>>\`\`\`\n>> ${AGENTS_START}\n>> ${AGENTS_END}\n>>\`\`\`\n`;
		expect(planAgentsBlock("AGENTS.md", nested).replaced).toBe(false);
	});
	test("a fence in a blockquote ends where the blockquote does, so a later quoted fence line does not hide the real pair", () => {
		const fence = "```";
		const existing = `> ${fence}\n> code\n\n${AGENTS_START}\nold\n${AGENTS_END}\n> ${fence}\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`> ${fence}\n> code\n\n${block}\n> ${fence}\n`);
		expect(upsertAgentsBlock("AGENTS.md", planned.text)).toBe(planned.text);
		// Two deep, closed by the shallower line that is itself the start marker.
		const quoted = block
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		const nested = `>> ${fence}\n>> code\n> ${AGENTS_START}\n> old\n> ${AGENTS_END}\n>> ${fence}\n`;
		const nestedPlanned = planAgentsBlock("AGENTS.md", nested);
		expect(nestedPlanned.replaced).toBe(true);
		expect(nestedPlanned.text).toBe(
			`>> ${fence}\n>> code\n${quoted}\n>> ${fence}\n`,
		);
		// An unquoted fence is not ended by a blank line.
		const unquoted = `${fence}\n\n${AGENTS_START}\n${AGENTS_END}\n${fence}\n`;
		expect(planAgentsBlock("AGENTS.md", unquoted).replaced).toBe(false);
		// A closer deeper than its opener still closes it.
		const deeperCloser = `> ${fence}\n> ${AGENTS_START}\n>> ${fence}\n${AGENTS_START}\n${AGENTS_END}\n`;
		expect(planAgentsBlock("AGENTS.md", deeperCloser).text).toBe(
			`> ${fence}\n> ${AGENTS_START}\n>> ${fence}\n${block}\n`,
		);
	});
	test("a pair in a list item stays in it: the item's marker on the first line, its continuation indent on the rest", () => {
		const listed = (first: string, rest: string, ending = "\n") =>
			block
				.split("\n")
				.map((line, position) => `${position === 0 ? first : rest}${line}`)
				.join(ending);
		const bulleted = `Tools:\n- ${AGENTS_START}\n  old\n  ${AGENTS_END}\n- Next.\n`;
		const planned = planAgentsBlock("AGENTS.md", bulleted);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`Tools:\n${listed("- ", "  ")}\n- Next.\n`);
		expect(upsertAgentsBlock("AGENTS.md", planned.text)).toBe(planned.text);
		// In a blockquote, with the end marker as its own list item.
		const quoted = `> - ${AGENTS_START}\r\n> - ${AGENTS_END}\r\n`;
		const once = upsertAgentsBlock("AGENTS.md", quoted);
		expect(once).toBe(`${listed("> - ", ">   ", "\r\n")}\r\n`);
		expect(upsertAgentsBlock("AGENTS.md", once)).toBe(once);
		// Ordered, and the other bullets.
		expect(
			upsertAgentsBlock("AGENTS.md", `  10) ${AGENTS_START}\n${AGENTS_END}`),
		).toBe(listed("  10) ", "      "));
		expect(
			upsertAgentsBlock("AGENTS.md", `* ${AGENTS_START}\n${AGENTS_END}`),
		).toBe(listed("* ", "  "));
		expect(
			upsertAgentsBlock("AGENTS.md", `+\t${AGENTS_START}\n${AGENTS_END}`),
		).toBe(listed("+\t", " \t"));
	});
	test("a list marker needs whitespace after it; other text before a marker leaves it text", () => {
		for (const existing of [`-${AGENTS_START}\n`, `Note: ${AGENTS_START}\n`])
			expect(planAgentsBlock("AGENTS.md", existing).replaced).toBe(false);
	});
	test("the block says the project uses llm-tests-forge and points at status and guide", () => {
		expect(block).toStartWith(AGENTS_START);
		expect(block).toEndWith(AGENTS_END);
		expect(block).toContain("llm-tests-forge status");
		expect(block).toContain("llm-tests-forge guide");
	});
	test("the block an agent reads, in full", () => {
		expect(block.split("\n")).toStrictEqual([
			AGENTS_START,
			"This project keeps LLM regression suites made with llm-tests-forge.",
			"Run `llm-tests-forge status` to see which suites exist and what is pending.",
			"Run `llm-tests-forge guide` before creating or changing a suite: it is the manual, and approving is the person's job.",
			PER_PROJECT_INVOCATIONS,
			AGENTS_END,
		]);
	});
	test("trailing blank lines before an appended block become exactly one", () => {
		expect(upsertAgentsBlock("AGENTS.md", "# Agents\n\n\n")).toBe(
			`# Agents\n\n${block}\n`,
		);
		expect(upsertAgentsBlock("AGENTS.md", "# Agents\r\n\r\n\r\n")).toBe(
			`# Agents\r\n\r\n${block.split("\n").join("\r\n")}\r\n`,
		);
	});
});

describe("upsertAgentsBlock: what opens and closes a code fence", () => {
	const block = agentsBlock();
	const quotedPair = `${AGENTS_START}\nquoted\n${AGENTS_END}\n`;
	const realPair = `${AGENTS_START}\nold\n${AGENTS_END}\n`;
	test("a pair between two closed fences is replaced, and what each fence quotes stays", () => {
		const fenced = `\`\`\`\n${quotedPair}\`\`\`\n`;
		const existing = `${fenced}${realPair}${fenced}`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`${fenced}${block}\n${fenced}`);
	});
	test("a closer longer than its opener closes it", () => {
		const existing = `\`\`\`\n${quotedPair}\`\`\`\`\n${realPair}`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`\`\`\`\n${quotedPair}\`\`\`\`\n${block}\n`);
	});
	test("a run of the other character never closes a fence, however long", () => {
		for (const [opener, other] of [
			["````", "~~~~~"],
			["~~~", "```"],
		]) {
			const existing = `${opener}\n${other}\n${quotedPair}${opener}\n`;
			const planned = planAgentsBlock("AGENTS.md", existing);
			expect(planned.replaced).toBe(false);
			expect(planned.text).toBe(`${existing}\n${block}\n`);
		}
	});
	test("a closer may be followed by spaces, but a line with other text after the run leaves the fence open", () => {
		const withText = `\`\`\`\n\`\`\` not yet\n${quotedPair}\`\`\`\n`;
		expect(planAgentsBlock("AGENTS.md", withText).replaced).toBe(false);
		const withSpaces = `\`\`\`\n${quotedPair}\`\`\` \t \n${realPair}`;
		expect(planAgentsBlock("AGENTS.md", withSpaces).text).toBe(
			`\`\`\`\n${quotedPair}\`\`\` \t \n${block}\n`,
		);
	});
	test("backticks after other text on a line open no fence", () => {
		const existing = `Use \`\`\` inline.\n${realPair}and \`\`\`\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`Use \`\`\` inline.\n${block}\nand \`\`\`\n`);
	});
	test("an info string may hold any character, a line separator or a lone carriage return too: the fence still quotes the pair", () => {
		for (const info of ["js x", "js x", "js\rx"]) {
			const existing = `\`\`\`${info}\n${quotedPair}\`\`\`\n`;
			const planned = planAgentsBlock("AGENTS.md", existing);
			expect(planned.replaced).toBe(false);
			expect(planned.text).toBe(`${existing}\n${block}\n`);
		}
	});
	test("a stray unclosed fence right after a closed one leaves the closed one protecting what it quotes", () => {
		const existing = `Text.\n\`\`\`\n${quotedPair}\`\`\`\n\`\`\`\nstray\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(false);
		expect(planned.text).toBe(`${existing}\n${block}\n`);
	});
	test("a fence closed by the end of its blockquote protects what it quotes, even when that line opens a stray fence", () => {
		const existing = `> \`\`\`\n> ${AGENTS_START}\n> ${AGENTS_END}\n\`\`\`\nstray\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(false);
		expect(planned.text).toBe(`${existing}\n${block}\n`);
	});
});
