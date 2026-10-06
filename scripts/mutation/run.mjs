// `bun run mutation [scope]`: Stryker takes a config file as its one
// positional argument, so the scope cannot be passed straight through;
// this wrapper checks it, hands it to stryker.config.mjs in STRYKER_SCOPE,
// and runs Stryker under node with the TypeScript resolve hook.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCOPE, SCOPE_NAMES, SCOPES } from "./scopes.mjs";

const requested = process.argv.slice(2);
const names = requested.length === 0 ? [DEFAULT_SCOPE] : requested;
if (requested.length > 1 || !Object.hasOwn(SCOPES, names[0])) {
	process.stderr.write(
		`Usage: bun run mutation [scope]\nScopes: ${SCOPE_NAMES.join(", ")} (default ${DEFAULT_SCOPE}); bun run mutation:all runs them all.\n`,
	);
	process.exit(2);
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const child = spawnSync(
	process.execPath,
	[
		"--import",
		fileURLToPath(new URL("./stryker-typescript.mjs", import.meta.url)),
		`${root}node_modules/@stryker-mutator/core/bin/stryker.js`,
		"run",
	],
	{
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, STRYKER_SCOPE: names[0] },
	},
);
process.exit(child.status ?? 1);
