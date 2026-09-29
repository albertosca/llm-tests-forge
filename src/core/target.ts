import { ForgeError } from "./errors";
import type { Suite, TargetKind } from "./schemas";

export type Target = Suite["target"];

/** The kinds whose shim the forge writes; exec and http reach code the person already runs. */
export const SHIM_KINDS = [
	"python",
	"javascript",
	"typescript",
	"elixir",
	"ruby",
	"rust",
	"go",
] as const;
export type ShimKind = (typeof SHIM_KINDS)[number];

export function isShimKind(kind: TargetKind): kind is ShimKind {
	return (SHIM_KINDS as readonly string[]).includes(kind);
}

export const DEFAULT_ENTRY: Record<ShimKind, string> = {
	python: "forge_target.py",
	javascript: "forge_target.mjs",
	typescript: "forge_target.ts",
	elixir: "forge_target.exs",
	ruby: "forge_target.rb",
	rust: "forge_target",
	go: "forge_target",
};

/**
 * The shim's file inside `.forge/`; undefined for exec and http, which have
 * none, so no caller can join a path with an empty entry.
 */
export function entryFor(target: Target): string | undefined {
	if (!isShimKind(target.kind)) return undefined;
	return target.entry ?? DEFAULT_ENTRY[target.kind];
}

/**
 * promptfoo's http provider hands the asserts whatever `transformResponse`
 * returns, and an object reaches them as "[object Object]". The expression
 * keeps text as it is and turns anything else into JSON. It must stay an
 * expression: promptfoo calls any transform holding `=>` as a function.
 */
export function httpTransform(response: string | undefined): string {
	const expression = response ?? "json";
	if (expression.includes("=>"))
		throw new ForgeError(
			"target.response must be an expression over json, not a function: promptfoo calls any text holding => as a function",
		);
	return `typeof (${expression}) === "string" ? (${expression}) : JSON.stringify(${expression})`;
}
