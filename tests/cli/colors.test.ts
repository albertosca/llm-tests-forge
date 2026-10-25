import { describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { colorEnabled, palette, renderItem } from "../../src/cli/colors";
import type { PendingItem } from "../../src/core/review";

const ESC = "\x1b[";

const kase: PendingItem = {
	kind: "case",
	item: {
		id: "s-01",
		scenario: "s",
		input: { page: "Full Name\nType here..." },
		expected: { fields: { count: 2, ok: true, name: "Acme" } },
		status: "pending",
		generated_by: "t",
	},
};

/**
 * A case whose body is not bound by the schema's types: the colorer only
 * reads the YAML `stringify` writes, so numbers and lists under `input` are
 * how it meets values a real run could not hold in a string-only field.
 */
const looseCase = (body: object): PendingItem =>
	({ kind: "case", item: body }) as PendingItem;

/** The text with every ANSI escape removed: what a reader sees. */
const plain = (text: string) =>
	text.replace(new RegExp(`${ESC.replace("[", "\\[")}[0-9;]*m`, "g"), "");

describe("colorEnabled", () => {
	test("on for an interactive terminal with no NO_COLOR", () => {
		expect(colorEnabled({}, true)).toBe(true);
	});
	test("off when output is not a terminal", () => {
		expect(colorEnabled({}, false)).toBe(false);
		expect(colorEnabled({}, undefined)).toBe(false);
	});
	test("off when NO_COLOR is set to anything non-empty, on when it is empty", () => {
		expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
		expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
	});
});

describe("renderItem without color", () => {
	test("is byte for byte the header and the YAML the loop always printed", () => {
		expect(renderItem(kase, palette(false))).toBe(
			`--- case s-01 ---\n${stringify(kase.item, { lineWidth: 0 }).trimEnd()}`,
		);
	});
	test("the palette's other painters pass text through untouched", () => {
		const painter = palette(false);
		expect(painter.error("cannot apply: x")).toBe("cannot apply: x");
		expect(painter.prompt("case s-01: [approve/skip]")).toBe(
			"case s-01: [approve/skip]",
		);
	});
});

describe("renderItem with color", () => {
	const out = renderItem(kase, palette(true));

	test("reads the same as the plain rendering once the escapes are gone, plus one rule before expected", () => {
		const lines = plain(out).split("\n");
		const rule = lines.findIndex((line) => line.startsWith("────"));
		expect(lines[rule + 1]).toBe("expected:");
		lines.splice(rule, 1);
		expect(lines.join("\n")).toBe(renderItem(kase, palette(false)));
	});

	test("the header is bold and the kind carries its own color", () => {
		expect(out.split("\n")[0]).toBe(
			`${ESC}1m--- ${ESC}36mcase${ESC}39m s-01 ---${ESC}22m`,
		);
	});

	test("keys are cyan, strings green, numbers and booleans yellow", () => {
		expect(out).toContain(`${ESC}36mid${ESC}39m: ${ESC}32ms-01${ESC}39m`);
		expect(out).toContain(`${ESC}36mcount${ESC}39m: ${ESC}33m2${ESC}39m`);
		expect(out).toContain(`${ESC}36mok${ESC}39m: ${ESC}33mtrue${ESC}39m`);
	});

	test("a block scalar's lines are text, not keys: 'Type here...' is green, never cyan", () => {
		expect(out).toContain(`${ESC}32m    Type here...${ESC}39m`);
		expect(out).not.toContain(`${ESC}36m    Full Name`);
	});

	test("a block scalar's marker is dim, whether it keeps the final newline or strips it", () => {
		expect(out).toContain(`${ESC}36mpage${ESC}39m: ${ESC}2m|-${ESC}22m`);
		const kept: PendingItem = {
			kind: "case",
			item: { ...kase.item, input: { page: "Full Name\nType here...\n" } },
		};
		expect(renderItem(kept, palette(true))).toContain(
			`${ESC}36mpage${ESC}39m: ${ESC}2m|${ESC}22m`,
		);
	});

	test("status is colored by its value", () => {
		expect(out).toContain(
			`${ESC}36mstatus${ESC}39m: ${ESC}33mpending${ESC}39m`,
		);
		for (const [status, code] of [
			["approved", "32"],
			["edited", "32"],
			["rejected", "31"],
		] as const) {
			const item: PendingItem = {
				kind: "case",
				item: { ...kase.item, status },
			};
			expect(renderItem(item, palette(true))).toContain(
				`${ESC}36mstatus${ESC}39m: ${ESC}${code}m${status}${ESC}39m`,
			);
		}
	});

	test("a list item is colored as a value, and a feature and a scenario get their own header color", () => {
		const feature: PendingItem = {
			kind: "feature",
			item: {
				id: "f",
				purpose: "p",
				inputs: [{ name: "page", kind: "text" }],
				output: { kind: "json", fields: ["questions"] },
				invariants: ["one"],
				status: "pending",
			},
		};
		const featureText = renderItem(feature, palette(true));
		expect(featureText.split("\n")[0]).toContain(`${ESC}35mfeature${ESC}39m`);
		expect(featureText).toContain(`  - ${ESC}32mquestions${ESC}39m`);
		const scenario: PendingItem = {
			kind: "scenario",
			item: {
				id: "s",
				kind: "happy",
				oracle: "fields",
				description: "d",
				status: "pending",
			},
		};
		expect(renderItem(scenario, palette(true)).split("\n")[0]).toContain(
			`${ESC}34mscenario${ESC}39m`,
		);
	});

	test("a line that is neither a plain key nor a list item passes through intact", () => {
		// An input named with a dot is outside the key pattern, so its line
		// is not colored; it must still reach the reader unchanged.
		const odd: PendingItem = {
			kind: "case",
			item: { ...kase.item, input: { "user.name": "a - b" } },
		};
		const lines = renderItem(odd, palette(true)).split("\n");
		expect(lines).toContain("  user.name: a - b");
	});

	test("a top-level block scalar's lines are text too, blank lines included", () => {
		const item: PendingItem = {
			kind: "case",
			item: { ...kase.item, generated_by: "Intro\n\nName: value" },
		};
		const lines = renderItem(item, palette(true)).split("\n");
		expect(lines).toContain(`${ESC}32m  Intro${ESC}39m`);
		expect(lines).toContain("");
		expect(lines).toContain(`${ESC}32m  Name: value${ESC}39m`);
	});

	test("a decimal is yellow as a whole, and a key that touches its value is text", () => {
		const item = looseCase({
			...kase.item,
			input: {
				ratio: 1.55,
				count: 12,
				note: "1 apple",
				pipe: "x|",
				tags: ["a:b"],
			},
		});
		const out = renderItem(item, palette(true));
		expect(out).toContain(`${ESC}36mratio${ESC}39m: ${ESC}33m1.55${ESC}39m`);
		expect(out).toContain(`  - ${ESC}32ma:b${ESC}39m`);
		expect(out).toContain(`${ESC}36mcount${ESC}39m: ${ESC}33m12${ESC}39m`);
		expect(out).toContain(`${ESC}36mnote${ESC}39m: ${ESC}32m1 apple${ESC}39m`);
		expect(out).toContain(`${ESC}36mpipe${ESC}39m: ${ESC}32mx|${ESC}39m`);
	});

	test("the line after a block scalar at the same indent is a key again", () => {
		const item = looseCase({ generated_by: "Intro\nB", id: "s-01" });
		expect(renderItem(item, palette(true))).toContain(
			`${ESC}36mid${ESC}39m: ${ESC}32ms-01${ESC}39m`,
		);
	});

	test("a block scalar inside a list item ends at its sibling key", () => {
		const item = looseCase({
			...kase.item,
			input: { pages: [{ text: "A\nB", other: 1 }] },
		});
		expect(renderItem(item, palette(true))).toContain(
			`      ${ESC}36mother${ESC}39m: ${ESC}33m1${ESC}39m`,
		);
	});

	test("only the top-level expected gets the rule, and only the status key is colored by status", () => {
		const item: PendingItem = {
			kind: "case",
			item: { ...kase.item, input: { expected: "x", note: "pending" } },
		};
		const out = renderItem(item, palette(true));
		const rules = plain(out)
			.split("\n")
			.filter((line) => line.startsWith("────"));
		expect(rules).toHaveLength(1);
		expect(out).toContain(`${ESC}36mnote${ESC}39m: ${ESC}32mpending${ESC}39m`);
	});

	test("a long line is never folded", () => {
		const long = "word ".repeat(40).trim();
		const item: PendingItem = {
			kind: "case",
			item: { ...kase.item, input: { text: long } },
		};
		expect(renderItem(item, palette(false))).toContain(`text: ${long}`);
	});

	test("errors are red and the prompt is bold", () => {
		const painter = palette(true);
		expect(painter.error("cannot apply: x")).toBe(
			`${ESC}31mcannot apply: x${ESC}39m`,
		);
		expect(painter.prompt("case s-01:")).toBe(`${ESC}1mcase s-01:${ESC}22m`);
	});
});

describe("renderItem with a frame", () => {
	const frame = {
		before: ["Item 1 of 2 · a case", "Input:", "  page: x"],
		showYaml: false,
		after: ["approve = yes", "keys: a approve"],
	};
	const yaml = stringify(kase.item, { lineWidth: 0 }).trimEnd();

	test("the header stays first, then the before lines, then the after lines, with no YAML", () => {
		expect(renderItem(kase, palette(false), frame)).toBe(
			[
				"--- case s-01 ---",
				"Item 1 of 2 · a case",
				"Input:",
				"  page: x",
				"approve = yes",
				"keys: a approve",
			].join("\n"),
		);
	});

	test("showYaml puts the item's YAML between the before and the after lines", () => {
		expect(renderItem(kase, palette(false), { ...frame, showYaml: true })).toBe(
			[
				"--- case s-01 ---",
				"Item 1 of 2 · a case",
				"Input:",
				"  page: x",
				yaml,
				"approve = yes",
				"keys: a approve",
			].join("\n"),
		);
	});

	test("with color the after lines are dim and the text is the uncolored rendering once the escapes are gone", () => {
		const colored = renderItem(kase, palette(true), frame);
		expect(colored).toContain(`${ESC}2mapprove = yes${ESC}22m`);
		expect(colored).toContain(`${ESC}2mkeys: a approve${ESC}22m`);
		expect(plain(colored)).toBe(renderItem(kase, palette(false), frame));
	});

	test("the hint painter is dim when enabled and untouched when not", () => {
		expect(palette(true).hint("x")).toBe(`${ESC}2mx${ESC}22m`);
		expect(palette(false).hint("x")).toBe("x");
	});
});

describe("renderItem paints the frame's own lines", () => {
	const frame = {
		before: [
			'Item 3 of 24 · a case of scenario "s"',
			"Scenario: a courteous no",
			"Input:",
			"  email: hello",
			"Expected, proposed by m (you confirm or correct it):",
			"  label: rejection",
			"Checked as label: the answer must come out as this label",
			"Valid labels: rejection, offer",
			"Rules the answer must respect (the feature's invariants):",
			"How these rules are used: the model that proposes cases is given them; check that the Expected follows them.",
			"  • never invent a label",
			"Note: looks like a near-duplicate of s-00 (flagged by dedupe).",
			"Expected: none yet; approve or edit will ask you for it.",
		],
		showYaml: false,
		after: [],
	};
	const colored = renderItem(kase, palette(true), frame);

	test("the counter line is bold", () => {
		expect(colored).toContain(
			`${ESC}1mItem 3 of 24 · a case of scenario "s"${ESC}22m`,
		);
	});

	test("the Input and Expected blocks go through the YAML colorer, their headings bold", () => {
		expect(colored).toContain(`${ESC}1mInput:${ESC}22m`);
		expect(colored).toContain(
			`${ESC}1mExpected, proposed by m (you confirm or correct it):${ESC}22m`,
		);
		expect(colored).toContain(
			`  ${ESC}36memail${ESC}39m: ${ESC}32mhello${ESC}39m`,
		);
		expect(colored).toContain(
			`  ${ESC}36mlabel${ESC}39m: ${ESC}32mrejection${ESC}39m`,
		);
	});

	test("the scenario label is dim and the oracle line is cyan", () => {
		expect(colored).toContain(`${ESC}2mScenario:${ESC}22m a courteous no`);
		expect(colored).toContain(
			`${ESC}36mChecked as label:${ESC}39m the answer must come out as this label`,
		);
	});

	test("valid labels are green after a dim prefix; the rules label is bold magenta and their explanation dim", () => {
		expect(colored).toContain(
			`${ESC}2mValid labels:${ESC}22m ${ESC}32mrejection, offer${ESC}39m`,
		);
		expect(colored).toContain(
			`${ESC}1m${ESC}35mRules the answer must respect${ESC}39m${ESC}22m (the feature's invariants):`,
		);
		expect(colored).toContain(
			`${ESC}2mHow these rules are used: the model that proposes cases is given them; check that the Expected follows them.${ESC}22m`,
		);
		expect(colored).toContain("  • never invent a label");
	});

	test("a near-duplicate note and a missing expected are yellow", () => {
		expect(colored).toContain(
			`${ESC}33mNote: looks like a near-duplicate of s-00 (flagged by dedupe).${ESC}39m`,
		);
		expect(colored).toContain(
			`${ESC}33mExpected: none yet; approve or edit will ask you for it.${ESC}39m`,
		);
	});

	test("the escapes add nothing: removed, the text is the uncolored rendering", () => {
		expect(plain(colored)).toBe(renderItem(kase, palette(false), frame));
	});

	test("an empty line inside an Input block stays in the block and stays empty", () => {
		const withBlank = renderItem(kase, palette(true), {
			...frame,
			before: [
				"Input:",
				"  body: |-",
				"    one",
				"",
				"    two",
				"Valid labels: a",
			],
		});
		expect(plain(withBlank)).toContain("    one\n\n    two\nValid labels: a");
		expect(withBlank).toContain(`${ESC}2mValid labels:${ESC}22m`);
	});

	test("an indented line outside any block is left alone", () => {
		const loose = renderItem(kase, palette(true), {
			...frame,
			before: ["Scenario: first", "  second line of the description"],
		});
		expect(loose).toContain("\n  second line of the description");
	});

	test("the preface painter is bold when enabled and untouched when not", () => {
		expect(palette(true).heading("x")).toBe(`${ESC}1mx${ESC}22m`);
		expect(palette(false).heading("x")).toBe("x");
		expect(palette(true).newScreen).toBe(`${ESC}2J${ESC}H`);
		expect(palette(false).newScreen).toBe("");
	});

	test("only a line that starts with the counter is bold, and two-digit counters count", () => {
		const counters = renderItem(kase, palette(true), {
			...frame,
			before: [
				"Item 10 of 100 · a case",
				"see Item 3 of 24 above",
				"Item 3 of x",
			],
		});
		expect(counters).toContain(`${ESC}1mItem 10 of 100 · a case${ESC}22m`);
		expect(counters).toContain("\nsee Item 3 of 24 above\n");
		expect(counters).toContain("\nItem 3 of x");
	});

	test("an indented line outside a block is plain even when it looks like YAML", () => {
		const loose = renderItem(kase, palette(true), {
			...frame,
			before: ["Scenario: first", "  fake: value"],
		});
		expect(loose).toContain("\n  fake: value");
	});

	test("a block scalar keeps its text green across an empty line", () => {
		const withBlank = renderItem(kase, palette(true), {
			...frame,
			before: ["Input:", "  body: |-", "    one", "", "    two"],
		});
		expect(withBlank).toContain(`${ESC}32m    two${ESC}39m`);
	});

	test("a first line that is indented is plain, not the start of a block", () => {
		const first = renderItem(kase, palette(true), {
			...frame,
			before: ["  fake: value"],
		});
		expect(first).toContain("\n  fake: value");
	});

	test("the fixed words only count at the start of a line, and a heading ends at its colon", () => {
		const loose = renderItem(kase, palette(true), {
			...frame,
			before: [
				"say Input:",
				"Input: trailing",
				"x Checked as label: y",
				"x Valid labels: a",
				"x Scenario: s",
			],
		});
		const lines = loose.split("\n").slice(1, 6);
		for (const line of lines) expect(line).toBe(plain(line));
	});
});
