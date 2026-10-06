// `bun run mutation [scope]`: Stryker takes a config file as its one
// positional argument, so the scope cannot be passed straight through;
// this wrapper checks it, hands it to stryker.config.mjs in STRYKER_SCOPE,
// and runs Stryker under node with the TypeScript resolve hook.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_SCOPE,
	mutationEnvironment,
	parseMutationArguments,
	SCOPE_NAMES,
} from "./scopes.mjs";

const requested = parseMutationArguments(process.argv.slice(2));
if (requested === null) {
	process.stderr.write(
		`Usage: bun run mutation [scope] [--mutate <file>]\nScopes: ${SCOPE_NAMES.join(", ")} (default ${DEFAULT_SCOPE}); bun run mutation:all runs them all.\n--mutate <file> runs the scope's tests against that one file of the scope only.\n`,
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
		env: mutationEnvironment(
			requested.scopeName,
			process.env,
			requested.mutateFile,
		),
	},
);
process.exit(child.status ?? 1);
