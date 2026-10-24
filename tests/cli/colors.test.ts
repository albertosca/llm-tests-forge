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
