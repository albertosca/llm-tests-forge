import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AGENTS_END,
	AGENTS_START,
	agentsBlock,
	PER_PROJECT_INVOCATIONS,
	planAgentsBlock,
	quotedLines,
	upsertAgentsBlock,
} from "../../src/core/agents-block";

// Built from code points so the test shows which character it means.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);

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
	test("a second start marker while the first is open names both lines; three blocks list every line", () => {
		expect(() =>
			upsertAgentsBlock(
				"AGENTS.md",
				`${AGENTS_START}\n${AGENTS_START}\n${AGENTS_END}\n`,
			),
		).toThrow(
			new Error(
				"AGENTS.md line 2 opens an llm-tests-forge block while the one opened on line 1 is still open",
			),
		);
		expect(() =>
			upsertAgentsBlock(
				"AGENTS.md",
				`a\n${AGENTS_START}\nb\n${AGENTS_START}\n`,
			),
		).toThrow(
			new Error(
				"AGENTS.md line 4 opens an llm-tests-forge block while the one opened on line 2 is still open",
			),
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
	test("a pair indented four spaces after a paragraph line continues the paragraph: it is replaced and keeps its indentation", () => {
		expect(
			upsertAgentsBlock(
				"AGENTS.md",
				`Text.\n    ${AGENTS_START}\n    ${AGENTS_END}`,
			),
		).toBe(
			`Text.\n${block
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
	test("an info string may hold a line separator or a lone carriage return: the fence still quotes the pair", () => {
		for (const info of [
			`js${LINE_SEPARATOR}x`,
			`js${PARAGRAPH_SEPARATOR}x`,
			"js\rx",
		]) {
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
	test("a closer takes only spaces and tabs after its run: a line separator, a no-break space, a vertical tab or a form feed leaves the fence open", () => {
		for (const after of [
			LINE_SEPARATOR,
			PARAGRAPH_SEPARATOR,
			NO_BREAK_SPACE,
			"\v",
			"\f",
		]) {
			const existing = `# doc\n\`\`\`\n\`\`\`${after}\n${quotedPair}\`\`\`\n\ntail\n`;
			const planned = planAgentsBlock("AGENTS.md", existing);
			expect({ after, replaced: planned.replaced }).toEqual({
				after,
				replaced: false,
			});
			expect(planned.text).toBe(`${existing}\n${block}\n`);
		}
	});
	test("a CRLF closer still closes its fence", () => {
		const existing = `\`\`\`\r\n${quotedPair.replaceAll("\n", "\r\n")}\`\`\` \r\n${realPair.replaceAll("\n", "\r\n")}`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(
			`\`\`\`\r\n${quotedPair.replaceAll("\n", "\r\n")}\`\`\` \r\n${block.split("\n").join("\r\n")}\r\n`,
		);
	});
	test("backticks with a backtick in the info string are inline code, not a fence; a tilde fence may carry backticks", () => {
		const existing = `Some text\n\`\`\`x\`\`\`\n\n${realPair}\n\`\`\`\ncode\n\`\`\`\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(
			`Some text\n\`\`\`x\`\`\`\n\n${block}\n\n\`\`\`\ncode\n\`\`\`\n`,
		);
		const tilde = `~~~ a\`b\n${quotedPair}~~~\n`;
		const tildePlanned = planAgentsBlock("AGENTS.md", tilde);
		expect(tildePlanned.replaced).toBe(false);
		expect(tildePlanned.text).toBe(`${tilde}\n${block}\n`);
	});
	test("depth is the number of `>`: markers at the same depth pair up however the quote markers are spaced", () => {
		const existing = `>  > ${AGENTS_START}\n>>${AGENTS_END}\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(
			`${block
				.split("\n")
				.map((line) => `>  > ${line}`)
				.join("\n")}\n`,
		);
	});
});

describe("upsertAgentsBlock: indented code and list items, as CommonMark reads them", () => {
	const block = agentsBlock();
	const quotedPair = `${AGENTS_START}\nquoted\n${AGENTS_END}\n`;
	const realPair = `${AGENTS_START}\nold\n${AGENTS_END}\n`;
	/** `text` with every line prefixed by `indentation`. */
	const indented = (indentation: string, text: string): string =>
		text.replace(/^(?=.)/gm, indentation);
	/** Whether planning `existing` finds a real pair; the text says so too. */
	function expectQuoted(existing: string): void {
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect({ existing, replaced: planned.replaced }).toEqual({
			existing,
			replaced: false,
		});
		expect(planned.text).toBe(`${existing}\n${block}\n`);
	}

	test("a pair indented four spaces after a blank line is indented code, not the block", () => {
		expectQuoted(`Text.\n\n${indented("    ", quotedPair)}`);
		// At the start of the file, by a tab, and in a blockquote.
		expectQuoted(indented("    ", quotedPair));
		expectQuoted(`Text.\n\n${indented("\t", quotedPair)}`);
		expectQuoted(`> Text.\n>\n${indented(">     ", quotedPair)}`);
	});
	test("indented code runs over its blank lines and ends at the first line indented less than four", () => {
		expectQuoted(
			`Text.\n\n    code\n    ${AGENTS_START}\n\n    ${AGENTS_END}\n`,
		);
		const ended = `Text.\n\n    code\n${realPair}`;
		const planned = planAgentsBlock("AGENTS.md", ended);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`Text.\n\n    code\n${block}\n`);
	});
	test("in a list item, indented code starts four columns past the item's content, not past the margin", () => {
		expectQuoted(`- Item.\n\n${indented("      ", quotedPair)}`);
		const inItem = `- Item.\n\n${indented("    ", realPair)}`;
		const planned = planAgentsBlock("AGENTS.md", inItem);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`- Item.\n\n${indented("    ", block)}\n`);
	});
	test("a fence in a list item is read from the item's content column, however far that is from the margin", () => {
		const fenced = `\`\`\`\n${quotedPair}\`\`\`\n`;
		expectQuoted(`1.  Item.\n\n${indented("    ", fenced)}`);
		expectQuoted(`- Item.\n\n${indented("    ", fenced)}`);
		expectQuoted(`- a\n  - b\n\n${indented("      ", fenced)}`);
		expectQuoted(`> - Item.\n>\n${indented(">     ", fenced)}`);
		// The fence on the item's own line, and on an empty item's next line.
		expectQuoted(`- \`\`\`\n${indented("  ", `${quotedPair}\`\`\`\n`)}`);
		expectQuoted(`-\n${indented("     ", fenced)}`);
	});
	test("a fence in a list item closes up to three columns past the item's content", () => {
		const existing = `- Item.\n\n  \`\`\`\n${indented("  ", quotedPair)}     \`\`\`\n\n${realPair}`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(
			`- Item.\n\n  \`\`\`\n${indented("  ", quotedPair)}     \`\`\`\n\n${block}\n`,
		);
	});
	test("a fence in a list item ends with the item: a line left of the item's content is outside both", () => {
		const existing = `- Item.\n  \`\`\`\n${realPair}  \`\`\`\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`- Item.\n  \`\`\`\n${block}\n  \`\`\`\n`);
	});
	test("an item with five spaces after its marker starts its content one column past the marker: the fence after them is indented code", () => {
		const existing = `-     \`\`\`\n${realPair}`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`-     \`\`\`\n${block}\n`);
	});
	test("tabs count from the line's start: `>` and a tab leave two columns, so a fence opens there and a marker there is no indented code", () => {
		expectQuoted(`>\t\`\`\`\n${indented("> ", quotedPair)}>\t\`\`\`\n`);
		// Two tabs reach six columns past the quote: indented code.
		expectQuoted(indented(">\t\t", quotedPair));
		const existing = `>\t${AGENTS_START}\n>\t${AGENTS_END}\n`;
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect(planned.replaced).toBe(true);
		expect(planned.text).toBe(`${indented(">\t", block)}\n`);
	});
	test("an ordered item may have up to nine digits: a fence at its content column, with no blank line before it, quotes the pair", () => {
		const fenced = `\`\`\`\n${quotedPair}\`\`\`\n`;
		expectQuoted(`10) Item.\n${indented("    ", fenced)}`);
	});
	test("a list marker stands at the line's start, needs a space or the end of the line after it, and a number needs `.` or `)`: otherwise the fence after it is paragraph text", () => {
		// The lines after it are indented three columns, where they would
		// still be inside the item the opener would otherwise start.
		for (const opener of ["-```", "x - ```", "a. ```", "12 ```"]) {
			const existing = `${opener}\n${indented("   ", realPair)}   \`\`\`\n`;
			const planned = planAgentsBlock("AGENTS.md", existing);
			expect({ opener, replaced: planned.replaced }).toEqual({
				opener,
				replaced: true,
			});
			expect(planned.text).toBe(
				`${opener}\n${indented("   ", block)}\n   \`\`\`\n`,
			);
		}
	});
	test("a quote marker without a space before a closer still lets it close the quoted fence", () => {
		const existing = `>\`\`\`\n>${AGENTS_START}\n>${AGENTS_END}\n>\`\`\`\n${indented(">", realPair)}`;
		expect(upsertAgentsBlock("AGENTS.md", existing)).toBe(
			`>\`\`\`\n>${AGENTS_START}\n>${AGENTS_END}\n>\`\`\`\n${indented(">", block)}\n`,
		);
	});
	test("an item's content starts after the up to four spaces past its marker; an empty item's, one column past it", () => {
		const fourSpaces = `-    Item.\n\n${indented("      ", realPair)}`;
		expect(upsertAgentsBlock("AGENTS.md", fourSpaces)).toBe(
			`-    Item.\n\n${indented("      ", block)}\n`,
		);
		expectQuoted(`-   \n\n${indented("      ", quotedPair)}`);
	});
	test("past five spaces after the marker the item's content is one column past it: the rest of its line is indented code, and lines at that column continue it", () => {
		expectQuoted(
			`-     \`\`\`\n${indented("      ", quotedPair)}      \`\`\`\n`,
		);
		expectQuoted(
			`-      ${AGENTS_START}\n       quoted\n       ${AGENTS_END}\n`,
		);
	});
	test("a line ends a list item by its leading spaces alone, however many spaces stand inside it", () => {
		const existing = `- Item.\n  \`\`\`\nText  here.\n${realPair}  \`\`\`\n`;
		expect(upsertAgentsBlock("AGENTS.md", existing)).toBe(
			`- Item.\n  \`\`\`\nText  here.\n${block}\n  \`\`\`\n`,
		);
	});
	test("a blank line inside a list item's fence keeps the fence open", () => {
		expectQuoted(`- \`\`\`\n  ${AGENTS_START}\n\n  ${AGENTS_END}\n  \`\`\`\n`);
	});
	test("a line indented four columns right after a fence closes is indented code", () => {
		expectQuoted(`\`\`\`\ncode\n\`\`\`\n${indented("    ", quotedPair)}`);
	});
	test("a line at another blockquote depth closes every list item: its indentation counts from the quote", () => {
		expectQuoted(`- Item.\n>\n${indented(">     ", quotedPair)}`);
	});
	test("a list item ended by a line at the margin leaves a fence at the margin a fence", () => {
		expectQuoted(`- Item.\nText.\n\`\`\`\n${quotedPair}\`\`\`\n`);
	});
	test("inside a list item's fence a quoted line at the item's column is content, and one left of it ends the item and the fence", () => {
		expectQuoted(`- \`\`\`\n${indented("  > ", quotedPair)}  \`\`\`\n`);
		const ended = `- \`\`\`\n${indented("> ", realPair)}  \`\`\`\n`;
		expect(upsertAgentsBlock("AGENTS.md", ended)).toBe(
			`- \`\`\`\n${indented("> ", block)}\n  \`\`\`\n`,
		);
		// A list in a blockquote: the item's column counts inside the quote.
		expectQuoted(`> - \`\`\`\n${indented(">   ", quotedPair)}>   \`\`\`\n`);
	});
	test("a fence closer deeper in blockquotes than its opener is content, not a closer", () => {
		expectQuoted(
			`> \`\`\`\n>> \`\`\`\n${indented("> ", quotedPair)}> \`\`\`\n`,
		);
	});
});

describe("upsertAgentsBlock: never overwrites what CommonMark reads as code", () => {
	const block = agentsBlock();
	const quotedPair = `${AGENTS_START}\nuser text\n${AGENTS_END}\n`;
	const realPair = `${AGENTS_START}\nold\n${AGENTS_END}\n`;
	const indented = (indentation: string, text: string): string =>
		text.replace(/^(?=.)/gm, indentation);
	function expectQuoted(existing: string): void {
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect({ existing, replaced: planned.replaced }).toEqual({
			existing,
			replaced: false,
		});
		expect(planned.text).toBe(`${existing}\n${block}\n`);
	}
	function expectReplaced(existing: string, expected: string): void {
		const planned = planAgentsBlock("AGENTS.md", existing);
		expect({ existing, text: planned.text }).toEqual({
			existing,
			text: expected,
		});
	}

	test("a thematic break is no list item: a fence after it two or three spaces in quotes the pair", () => {
		expectQuoted(
			`* * *\n\n  \`\`\`\n${AGENTS_START}\nuser text\n${AGENTS_END}\n  \`\`\`\n`,
		);
		for (const rule of ["* * *", "- - -", "- ---", "* ***", "___"])
			for (const indentation of ["  ", "   "])
				expectQuoted(
					`${rule}\n\n${indentation}\`\`\`\n${quotedPair}${indentation}\`\`\`\n`,
				);
	});
	test("an empty list item cannot interrupt a paragraph, nor an ordered one that does not start at 1", () => {
		expectQuoted(`intro\n1. \n   ~~~\n${quotedPair}   ~~~\n`);
		// `2. text` continues the paragraph, so the lines below are lazy
		// paragraph text, not a fence in an item.
		expectReplaced(
			`intro\n2. text\n${indented("    ", `~~~\n${realPair}`)}`,
			`intro\n2. text\n    ~~~\n${indented("    ", block)}\n`,
		);
	});
	test("indented code starts after a heading, a thematic break or an HTML block that ended, but not inside an HTML block", () => {
		for (const before of [
			"# Title",
			"Title\n===",
			"Title\n---",
			"* * *",
			"<!-- a note -->",
		])
			expectQuoted(`${before}\n${indented("    ", quotedPair)}`);
		expectReplaced(
			`<div>\n${indented("    ", realPair)}</div>\n`,
			`<div>\n${indented("    ", block)}\n</div>\n`,
		);
		expectQuoted(`<div>\n\n${indented("    ", quotedPair)}`);
	});
	test("a new blockquote, or a blockquote in a list item, ends the paragraph before it: indented code may start inside it", () => {
		expectQuoted(`intro\n${indented(">\t\t", quotedPair)}`);
		expectQuoted(`- item\n${indented("  >     ", quotedPair)}`);
	});
	test("a line indented four columns with no new block before it is a lazy paragraph line, even outside the paragraph's blockquote", () => {
		expectReplaced(
			`> intro\n${indented("    ", realPair)}`,
			`> intro\n${indented("    ", block)}\n`,
		);
	});
	test("inside an HTML block a quoted fence is HTML, not a fence", () => {
		expectReplaced(
			`<div>\n>\t~~~\n${indented("> ", realPair)}>\t~~~\n`,
			`<div>\n>\t~~~\n${indented("> ", block)}\n>\t~~~\n`,
		);
	});
});

describe("quotedLines: the lines CommonMark reads as code", () => {
	/** The 1-based numbers of the lines quoted, blank lines left out (they can never be a marker). */
	function quotedNumbers(text: string): number[] {
		const lines = text.split("\n");
		return quotedLines(lines).flatMap((quoted, index) =>
			quoted && lines[index]?.trim() !== "" ? [index + 1] : [],
		);
	}
	// Each expectation is commonmark.js 0.31.2's code lines, except where it
	// ends inside an unclosed fence (marked): there the fence is no fence.
	const cases: [string, string, number[]][] = [
		[
			"a line four columns in leaves its blockquote, and the fence in it",
			"> ```\n    > x\n> a\n> b\n> ```\n",
			[1, 2, 5],
		],
		[
			"three columns in, a `>` continues its blockquote",
			"> ```\n   > x\n> ```\n",
			[1, 2, 3],
		],
		["one space after `>` belongs to the marker", ">\n>    x\n", []],
		[
			"a closer four columns in is content",
			"```\n    ```\nx\n```\n",
			[1, 2, 3, 4],
		],
		["a fence inside an HTML block is HTML", "<div>\n```\nx\n```\n", []],
		[
			"an HTML comment ends at `-->`, and code may follow",
			"<!--\nx\n-->\n    code\n",
			[4],
		],
		[
			"an HTML block's end is looked for past the blockquote marker",
			"> <!DOCTYPE html\n>     code\n",
			[],
		],
		[
			"on each line of the HTML block too",
			"> <!DOCTYPE html\n> x\n>     code\n",
			[],
		],
		[
			"an item with nothing but spaces is empty, and a blank line ends it",
			"-      \n\n  ```\nx\n  ```\n",
			[3, 4, 5],
		],
		["an empty item, then a blank line", "-\n\n  ```\nx\n  ```\n", [3, 4, 5]],
		[
			"a lone tag cannot interrupt a paragraph",
			"intro\n<span>\n```\nx\n```\n",
			[3, 4, 5],
		],
		[
			"a block tag can interrupt a paragraph",
			"intro\n<div>\n```\nx\n```\n",
			[],
		],
		["a lone tag starts an HTML block", "<span>\n```\nx\n```\n", []],
		["a lone tag in capitals too", "<SPAN>\n```\nx\n```\n", []],
		["a closing block tag", "intro\n</div>\n```\nx\n```\n", []],
		["a block tag in capitals", "intro\n<DIV>\n```\nx\n```\n", []],
		["a block tag cut at the line's end", "intro\n<div\n```\nx\n```\n", []],
		["a self-closing block tag", "intro\n<div/>\n```\nx\n```\n", []],
		["a block tag with an attribute", "intro\n<div x>\n```\nx\n```\n", []],
		[
			"a longer name is no block tag",
			"intro\n<divx>\n```\nx\n```\n",
			[3, 4, 5],
		],
		[
			"a block tag after text is text",
			"intro\nx <div>\n```\nx\n```\n",
			[3, 4, 5],
		],
		["`===` with no paragraph is a paragraph", "===\n    code\n", []],
		["a setext underline is the whole line", "intro\nx ==\n    code\n", []],
		[
			"an ordered item that starts at 1 interrupts a paragraph",
			"intro\n1. ```\n   x\n   ```\n",
			[2, 3, 4],
		],
		[
			"one that starts at 2 does not (the fence then never closes: marked)",
			"intro\n2. ```\n   x\n   ```\n",
			[],
		],
		[
			"a bullet item interrupts a paragraph",
			"intro\n- ```\n  x\n  ```\n",
			[2, 3, 4],
		],
		[
			"an item's own line can hold indented code, after a paragraph too",
			"intro\n-      code\n",
			[2],
		],
		[
			"a blockquote line with only spaces is blank",
			"  > x\n  > \n  >     code\n",
			[3],
		],
		["with spaces after the marker too", "> a\n>   \n>     code\n", [3]],
		[
			"a lazy line keeps the paragraph's blockquote open",
			"> a\nb\n>     code\n",
			[],
		],
		["`##` is a heading", "## Title\n    code\n", [2]],
		["a `#` after text is text", "Title #\n    code\n", []],
		["a lone `#` is a heading", "#\n    code\n", [2]],
		["seven `#` are text", "####### x\n    code\n", []],
		[
			"a blank line does not end an HTML comment",
			"<!--\n\n    code\n-->\n",
			[],
		],
		[
			"a declaration interrupts a paragraph and runs to its `>`",
			"intro\n<!DOCTYPE\n```\nx\n```\n",
			[],
		],
		[
			"a declaration after text is text",
			"intro\nx <!D\n```\nx\n```\n",
			[3, 4, 5],
		],
		[
			"a CDATA section interrupts a paragraph",
			"intro\n<![CDATA[\n```\nx\n```\n",
			[],
		],
		[
			"a CDATA section after text is text",
			"intro\nx <![CDATA[\n```\nx\n```\n",
			[3, 4, 5],
		],
		["a heading tag is a block tag", "intro\n<h1>\n```\nx\n```\n", []],
		["text after a break makes list items", "* * * x\n    code\n", []],
		["`_` runs after text are text", "x ___\n    code\n", []],
		["`*` runs after text are text", "x * * *\n    code\n", []],
		["text after `___` is a paragraph", "___ x\n    code\n", []],
		["`___` is a thematic break", "___\n    code\n", [2]],
		["spaces may stand between its `_`", "_  _  _\n    code\n", [2]],
		["`-` runs after text are text", "x - - -\n    code\n", []],
		["text after `- - -` makes list items", "- - - x\n    code\n", []],
		[
			"`--` under a paragraph is a setext underline",
			"intro\n--\n    code\n",
			[3],
		],
		["a list marker after text is text", "x -     code\n", []],
		[
			"a `<pre>` after text is text",
			"intro\nx <pre>\n```\nx\n```\n",
			[3, 4, 5],
		],
		[
			"`<pre` cut at the line's end starts HTML",
			"intro\n<pre\n```\nx\n```\n",
			[],
		],
		["`<pre` and a space starts HTML", "intro\n<pre x>\n```\nx\n```\n", []],
		["a `<?` after text is text", "intro\nx <?\n```\nx\n```\n", [3, 4, 5]],
		["`<?` starts HTML", "intro\n<?\n```\nx\n```\n", []],
		[
			"backticks anywhere after a backtick run make it no fence (marked)",
			"```ab`\nx\n```\n",
			[],
		],
		["a tilde run after text is no fence (marked)", "a ~~~\nx\n~~~\n", []],
		["one tilde is no fence (marked)", "~\nx\n~~~\n", []],
	];
	for (const [name, text, expected] of cases)
		test(name, () => {
			expect({ text, quoted: quotedNumbers(text) }).toEqual({
				text,
				quoted: expected,
			});
		});
});
