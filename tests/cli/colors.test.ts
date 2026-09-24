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

/** The text with every ANSI escape removed: what a reader sees. */
const plain = (s: string) =>
	s.replace(new RegExp(`${ESC.replace("[", "\\[")}[0-9;]*m`, "g"), "");

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
		const p = palette(false);
		expect(p.error("cannot apply: x")).toBe("cannot apply: x");
		expect(p.prompt("case s-01: [approve/skip]")).toBe(
			"case s-01: [approve/skip]",
		);
	});
});

describe("renderItem with color", () => {
	const out = renderItem(kase, palette(true));

	test("reads the same as the plain rendering once the escapes are gone, plus one rule before expected", () => {
		const lines = plain(out).split("\n");
		const rule = lines.findIndex((l) => l.startsWith("────"));
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
		const f = renderItem(feature, palette(true));
		expect(f.split("\n")[0]).toContain(`${ESC}35mfeature${ESC}39m`);
		expect(f).toContain(`  - ${ESC}32mquestions${ESC}39m`);
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
			item: { ...kase.item, input: { "user.name": "x" } },
		};
		const lines = renderItem(odd, palette(true)).split("\n");
		expect(lines).toContain("  user.name: x");
	});

	test("errors are red and the prompt is bold", () => {
		const p = palette(true);
		expect(p.error("cannot apply: x")).toBe(
			`${ESC}31mcannot apply: x${ESC}39m`,
		);
		expect(p.prompt("case s-01:")).toBe(`${ESC}1mcase s-01:${ESC}22m`);
	});
});
