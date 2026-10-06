// `bun run mutation:all`: every scope, one after another (never in
// parallel: each run already uses every CPU). A failing scope does not stop
// the next, so one run reports them all; the exit status is the first
// failure's.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCOPE_NAMES } from "./scopes.mjs";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
let exitStatus = 0;
for (const name of SCOPE_NAMES) {
	process.stdout.write(`\n=== mutation scope: ${name} ===\n`);
	const child = spawnSync(process.execPath, [runner, name], {
		stdio: "inherit",
	});
	if (exitStatus === 0) exitStatus = child.status ?? 1;
}
process.exit(exitStatus);
