import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { copyLicense, licensePath } from "./license";
import { RELEASE_TARGETS, type ReleaseTarget } from "./targets";
import { checkVersions, GEM_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/**
 * The platform of the fallback gem, which ships no binary. RubyGems prefers
 * a gem for the local platform over a `ruby` one, so it installs this one
 * only where no target gem fits (musl Linux, FreeBSD, …), and its shim names
 * the platform and points at install.sh.
 */
export const FALLBACK_GEM_PLATFORM = "ruby";

/** The file name `renderGems` gives the gem of one target. */
export function gemFileName(version: string, target: ReleaseTarget): string {
	return `llm-tests-forge-${version}-${target.gemPlatform}.gem`;
}

/** The file name `renderFallbackGem` gives the fallback gem: no platform suffix, as `gem build` names a `ruby` gem. */
export function fallbackGemFileName(version: string): string {
	return `llm-tests-forge-${version}.gem`;
}

/** The release version, once the gemspec carries it; a stale gemspec is refused naming it. */
async function stampedVersion(root: string): Promise<string> {
	const stale = await checkVersions(root, GEM_MANIFESTS);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${await releaseVersion(root)} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	return releaseVersion(root);
}

/**
 * Runs `gem build` on a scratch copy of `packages/gem` with the LICENSE
 * beside it (the gemspec copies the binary into the directory it is built
 * in, which must not be the committed tree), with `platform` and `binary` in
 * the two variables the gemspec reads; with no binary, the variable is
 * removed from the inherited environment, so the gemspec builds the
 * fallback. Writes and returns `gem`.
 */
async function buildGem(
	root: string,
	gemCommand: string,
	platform: string,
	binary: string | undefined,
	gem: string,
): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "forge-gem-build-"));
	try {
		await cp(join(root, "packages/gem"), scratch, { recursive: true });
		await copyLicense(root, scratch);
		const { FORGE_GEM_BINARY: _inherited, ...inheritedEnvironment } =
			process.env;
		const child = Bun.spawn(
			[gemCommand, "build", "llm-tests-forge.gemspec", "--output", gem],
			{
				cwd: scratch,
				env: {
					...inheritedEnvironment,
					FORGE_GEM_PLATFORM: platform,
					...(binary === undefined ? {} : { FORGE_GEM_BINARY: binary }),
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
				`gem build failed for ${platform} (exit ${exitCode}): ${stderr.trim()}`,
				{ file: gem },
			);
		if (!(await Bun.file(gem).exists()))
			throw new ForgeError("gem build did not write the gem", { file: gem });
		return gem;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
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
	const version = await stampedVersion(root);
	for (const target of targets) {
		const source = join(binariesDirectory, target.assetName);
		if (!(await Bun.file(source).exists()))
			throw new ForgeError("release binary is missing", { file: source });
	}
	await licensePath(root);
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	const written: string[] = [];
	for (const target of targets)
		written.push(
			await buildGem(
				root,
				gemCommand,
				target.gemPlatform,
				resolve(binariesDirectory, target.assetName),
				join(absoluteOut, gemFileName(version, target)),
			),
		);
	return written;
}

/**
 * Builds the fallback gem (platform `ruby`, no binary) into `outDirectory`
 * from the same gemspec, so it carries the same stamped version; returns its
 * path. `gemCommand` exists for the tests.
 */
export async function renderFallbackGem(
	outDirectory: string,
	root: string = REPOSITORY_ROOT,
	gemCommand = "gem",
): Promise<string> {
	const version = await stampedVersion(root);
	await licensePath(root);
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	return buildGem(
		root,
		gemCommand,
		FALLBACK_GEM_PLATFORM,
		undefined,
		join(absoluteOut, fallbackGemFileName(version)),
	);
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
