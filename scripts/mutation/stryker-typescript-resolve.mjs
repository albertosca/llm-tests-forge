// Stryker type-checks each mutant with @stryker-mutator/typescript-checker in
// its native mode, which compiles with the project's own TypeScript 7 (the Go
// port), the same compiler `bun run typecheck` runs. Two of its imports do not
// resolve on their own; this resolve hook resolves them, for imports made
// from inside @stryker-mutator only:
//
// - `typescript`: the checker and Stryker's tsconfig rewrite still read
//   tsconfig.json and format diagnostics with TypeScript's JS API
//   (parseConfigFileTextToJson, sys, formatDiagnostics). TypeScript 7's
//   package exports only a version number, so they get TypeScript 5, which
//   is installed under the `typescript5` alias.
// - `@typescript/native/<entry>`: the checker loads TypeScript 7's API under
//   that alias name; it is the project's `typescript/<entry>`, so it is sent
//   there instead of pinning TypeScript 7 a second time.
//
// Every other import, and `tsc` in `bun run typecheck`, is untouched. Bun has
// no nested overrides (a scoped `overrides` or `resolutions` entry installs
// nothing), and Node's ES module resolver ignores NODE_PATH, so a resolve
// hook is where this can be said. stryker-typescript.mjs registers it.

const STRYKER_PACKAGES = "/node_modules/@stryker-mutator/";
const NATIVE_ALIAS = "@typescript/native/";

/**
 * A `module.registerHooks` resolve hook.
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: { parentURL?: string }) => unknown} nextResolve
 */
export function resolveForStryker(specifier, context, nextResolve) {
	if (!context.parentURL?.includes(STRYKER_PACKAGES)) {
		return nextResolve(specifier, context);
	}
	if (specifier === "typescript") {
		return nextResolve("typescript5", context);
	}
	if (specifier.startsWith(NATIVE_ALIAS)) {
		return nextResolve(
			`typescript/${specifier.slice(NATIVE_ALIAS.length)}`,
			context,
		);
	}
	return nextResolve(specifier, context);
}
