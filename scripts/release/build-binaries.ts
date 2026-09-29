import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { RELEASE_TARGETS } from "./targets";

const ENTRY_POINT = resolve(import.meta.dir, "../../src/cli/bin.ts");

/** Compiles the CLI for every release target (or just `only`, a `bunTarget`) into `outDirectory` under the asset names; returns the paths written. */
export async function buildBinaries(
	outDirectory: string,
	only?: string,
): Promise<string[]> {
	const targets = RELEASE_TARGETS.filter(
		(target) => only === undefined || target.bunTarget === only,
	);
	if (targets.length === 0)
		throw new UsageError(
			`--only ${only} is not a release target (one of ${RELEASE_TARGETS.map((target) => target.bunTarget).join(", ")})`,
		);
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	const written: string[] = [];
	for (const target of targets) {
		const outfile = join(absoluteOut, target.assetName);
		// The build writes a temporary file into its working directory, so it
		// runs beside the output directory, not in the source tree.
		const build = Bun.spawnSync(
			[
				"bun",
				"build",
				"--compile",
				`--target=${target.bunTarget}`,
				ENTRY_POINT,
				"--outfile",
				outfile,
			],
			{ cwd: dirname(absoluteOut) },
		);
		if (build.exitCode !== 0)
			throw new ForgeError(
				`bun build failed for ${target.bunTarget}: ${build.stderr.toString().trim()}`,
				{ file: outfile },
			);
		written.push(outfile);
	}
	return written;
}

/** `build-binaries.ts <out-directory> [--only <bunTarget>]`: returns the exit code. */
export async function runBuildBinaries(
	argumentsList: string[],
	print: (line: string) => void,
): Promise<number> {
	const usage = "usage: build-binaries.ts <out-directory> [--only <bunTarget>]";
	const [outDirectory, ...rest] = argumentsList;
	if (outDirectory === undefined || outDirectory.startsWith("--"))
		throw new UsageError(usage);
	let only: string | undefined;
	if (rest.length === 2 && rest[0] === "--only") only = rest[1];
	else if (rest.length > 0) throw new UsageError(usage);
	for (const path of await buildBinaries(outDirectory, only)) print(path);
	return 0;
}

await runMain(import.meta.main, runBuildBinaries);
