import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { RELEASE_TARGETS, type ReleaseTarget } from "./targets";
import { checkVersions, GEM_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** The file name `renderGems` gives the gem of one target. */
export function gemFileName(version: string, target: ReleaseTarget): string {
	return `llm-tests-forge-${version}-${target.gemPlatform}.gem`;
}

/**
 * Builds one gem per target into `outDirectory` by running `gem build` on a
 * scratch copy of `packages/gem` (the gemspec copies the binary into the
 * directory it is built in, which must not be the committed tree), with the
 * target's platform and binary in the two variables the gemspec reads;
 * returns the gem paths in target order. The gems carry the version of the
 * committed gemspec, which must be stamped. `gemCommand` and `targets` exist
 * for the tests.
 */
export async function renderGems(
	binariesDirectory: string,
	outDirectory: string,
	root: string = REPOSITORY_ROOT,
	gemCommand = "gem",
	targets: readonly ReleaseTarget[] = RELEASE_TARGETS,
): Promise<string[]> {
	const stale = await checkVersions(root, GEM_MANIFESTS);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${await releaseVersion(root)} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	const version = await releaseVersion(root);
	for (const target of targets) {
		const source = join(binariesDirectory, target.assetName);
		if (!(await Bun.file(source).exists()))
			throw new ForgeError("release binary is missing", { file: source });
	}
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	const written: string[] = [];
	for (const target of targets) {
		const scratch = await mkdtemp(join(tmpdir(), "forge-gem-build-"));
		try {
			await cp(join(root, "packages/gem"), scratch, { recursive: true });
			const gem = join(absoluteOut, gemFileName(version, target));
			const child = Bun.spawn(
				[gemCommand, "build", "llm-tests-forge.gemspec", "--output", gem],
				{
					cwd: scratch,
					env: {
						...process.env,
						FORGE_GEM_PLATFORM: target.gemPlatform,
						FORGE_GEM_BINARY: resolve(binariesDirectory, target.assetName),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stderr, exitCode] = await Promise.all([
				new Response(child.stderr).text(),
				child.exited,
				new Response(child.stdout).text(),
			]);
			if (exitCode !== 0)
				throw new ForgeError(
					`gem build failed for ${target.gemPlatform} (exit ${exitCode}): ${stderr.trim()}`,
					{ file: gem },
				);
			if (!(await Bun.file(gem).exists()))
				throw new ForgeError("gem build did not write the gem", { file: gem });
			written.push(gem);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}
	return written;
}

/** `gems.ts <binaries-directory> <out-directory>`: returns the exit code. */
export async function runGems(
	argumentsList: string[],
	print: (line: string) => void,
): Promise<number> {
	const [binariesDirectory, outDirectory, ...extra] = argumentsList;
	if (
		binariesDirectory === undefined ||
		outDirectory === undefined ||
		extra.length > 0
	)
		throw new UsageError("usage: gems.ts <binaries-directory> <out-directory>");
	for (const gem of await renderGems(binariesDirectory, outDirectory))
		print(gem);
	return 0;
}

await runMain(import.meta.main, runGems);
