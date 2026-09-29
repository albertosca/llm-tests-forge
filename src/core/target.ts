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

export function entryFor(target: Target): string {
	if (target.entry !== undefined) return target.entry;
	return isShimKind(target.kind) ? DEFAULT_ENTRY[target.kind] : "";
}

/**
 * promptfoo's http provider hands the asserts whatever `transformResponse`
 * returns, and an object reaches them as "[object Object]". The expression
 * keeps text as it is and turns anything else into JSON. It must stay an
 * expression: promptfoo calls any transform holding `=>` as a function.
 */
export function httpTransform(response: string | undefined): string {
	const expression = response ?? "json";
	return `typeof (${expression}) === "string" ? (${expression}) : JSON.stringify(${expression})`;
}
