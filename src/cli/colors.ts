import { stringify } from "yaml";
import type { PendingItem } from "../core/review";
import type { Frame } from "./review-frame";

/**
 * Color for the review screen. Every item used to be printed as bare YAML,
 * white on black, and reading forty cases that way was the slowest part of
 * a review. Plain ANSI codes rather than a library: the palette is small and
 * the output must stay byte-identical to the uncolored rendering once the
 * escapes are removed, which the tests hold it to.
 */

const code = (open: number, close: number) => (text: string) =>
	`\x1b[${open}m${text}\x1b[${close}m`;

const bold = code(1, 22);
const red = code(31, 39);
const green = code(32, 39);
const yellow = code(33, 39);
const blue = code(34, 39);
const magenta = code(35, 39);
const cyan = code(36, 39);
const dim = code(2, 22);

/**
 * On for an interactive terminal, off when the output is redirected, and off
 * whenever `NO_COLOR` is set to a non-empty value (https://no-color.org).
 */
export function colorEnabled(
	environment: Record<string, string | undefined>,
	isTTY: boolean | undefined,
): boolean {
	return isTTY === true && (environment.NO_COLOR ?? "") === "";
}

export interface Palette {
	enabled: boolean;
	/** A line the loop reports as a refused decision. */
	error: (line: string) => string;
	/** The question asked for each item. */
	prompt: (line: string) => string;
	/** The lines that explain the keys, quieter than the item itself. */
	hint: (line: string) => string;
}

const identity = (text: string) => text;

export function palette(enabled: boolean): Palette {
	return enabled
		? { enabled, error: red, prompt: bold, hint: dim }
		: { enabled, error: identity, prompt: identity, hint: identity };
}

const KIND_COLOR: Record<PendingItem["kind"], (text: string) => string> = {
	feature: magenta,
	scenario: blue,
	case: cyan,
};

const STATUS_COLOR: Record<string, (text: string) => string> = {
	pending: yellow,
	approved: green,
	edited: green,
	rejected: red,
};

/** The marker `stringify` writes for a block scalar: it never folds one with `>`. */
function isBlockMarker(raw: string): boolean {
	return raw === "|" || raw === "|-";
}

/** A scalar as it reads: numbers, booleans and null yellow, text green. */
function value(raw: string): string {
	if (isBlockMarker(raw)) return dim(raw);
	if (/^(-?\d+(\.\d+)?|true|false|null|~)$/.test(raw)) return yellow(raw);
	return green(raw);
}

const KEY_LINE = /^(\s*)(- )?([A-Za-z_][\w-]*):( (.*))?$/;
const ITEM_LINE = /^(\s*)- (.+)/;

/**
 * Colors YAML as `stringify` writes it, line by line. The one state it keeps
 * is a block scalar: the lines under `page: |-` are the page's own text, and
 * a line of it that happens to look like `Name: value` is still text.
 */
function colorYaml(yaml: string): string {
	// Stryker disable next-line UnaryOperator: the first line of any YAML `stringify` writes has no indent, so starting at 1 leaves the block branch exactly as -1 does
	let blockIndent = -1;
	const out: string[] = [];
	for (const line of yaml.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (blockIndent >= 0) {
			if (line === "" || indent > blockIndent) {
				out.push(line === "" ? line : green(line));
				continue;
			}
			blockIndent = -1;
		}
		const key = KEY_LINE.exec(line);
		if (key) {
			const [
				,
				// Stryker disable next-line StringLiteral: KEY_LINE's first group is `(\s*)`, which always participates in a match, so this default is never read.
				lead = "",
				dash = "",
				// Stryker disable next-line StringLiteral: KEY_LINE's third group is the key name, which always participates in a match, so this default is never read.
				name = "",
				,
				rest,
			] = key;
			// Separates the answer being judged from the input it answers.
			if (lead === "" && name === "expected") out.push(dim("─".repeat(40)));
			const painted =
				rest === undefined
					? ""
					: name === "status" && STATUS_COLOR[rest] !== undefined
						? ` ${STATUS_COLOR[rest](rest)}`
						: ` ${value(rest)}`;
			out.push(`${lead}${dash}${cyan(name)}:${painted}`);
			if (rest !== undefined && isBlockMarker(rest))
				blockIndent = lead.length + dash.length;
			continue;
		}
		const item = ITEM_LINE.exec(line);
		if (item) {
			// Stryker disable next-line StringLiteral: ITEM_LINE's two groups, `(\s*)` and `(.+)`, both always participate in a match, so neither default is ever read.
			const [, lead = "", rest = ""] = item;
			out.push(`${lead}- ${value(rest)}`);
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/**
 * What the review loop prints for one item: a header naming its kind and id,
 * then the item as YAML. Without color and without a frame it is exactly what
 * the loop always printed, so nothing downstream of a redirected run changes.
 * A frame adds the explanatory lines around the item (see `review-frame.ts`)
 * and may replace the YAML with them.
 */
export function renderItem(
	item: PendingItem,
	colors: Palette,
	frame?: Frame,
): string {
	const yaml = stringify(item.item, { lineWidth: 0 }).trimEnd();
	const header = colors.enabled
		? bold(`--- ${KIND_COLOR[item.kind](item.kind)} ${item.item.id} ---`)
		: `--- ${item.kind} ${item.item.id} ---`;
	const body = colors.enabled ? colorYaml(yaml) : yaml;
	if (!frame) return `${header}\n${body}`;
	return [
		header,
		...frame.before,
		...(frame.showYaml ? [body] : []),
		...frame.after.map(colors.hint),
	].join("\n");
}
