import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { licensePath } from "./license";
import { RELEASE_TARGETS, type ReleaseTarget } from "./targets";
import { checkVersions, PYPI_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** The semver prerelease labels a wheel version can carry, and PEP 440's spelling of each. */
const PEP_440_PRERELEASES: Record<string, string> = {
	alpha: "a",
	beta: "b",
	rc: "rc",
};

/**
 * The PEP 440 form of a semver release version, as uv writes it in the
 * wheel's file name: `0.1.0-rc.1` becomes `0.1.0rc1`, `-alpha.N` becomes
 * `aN`, `-beta.N` becomes `bN`, and a plain `X.Y.Z` stays as it is. Any
 * other label is refused naming it, since the wheel would not carry the
 * version the tag names. So is a number with a leading zero (`-rc.01`):
 * SemVer forbids it, and PEP 440 normalises it away (`rc1`).
 */
export function pep440Version(version: string): string {
	const parts = /^(\d+\.\d+\.\d+)(.*)$/.exec(version);
	if (parts === null)
		throw new ForgeError(`version ${version} is not MAJOR.MINOR.PATCH`);
	// Build metadata (after `+`) may have leading zeros; it is refused below
	// as a label PEP 440 cannot express.
	const precedencePart = version.split("+", 1)[0] ?? version;
	const leadingZero = /(?<!\d)0\d+/.exec(precedencePart)?.[0];
	if (leadingZero !== undefined)
		throw new ForgeError(
			`version ${version} has a number with a leading zero (${leadingZero}), which SemVer forbids and the wheel would spell without it`,
		);
	const [, release = "", suffix = ""] = parts;
	if (suffix === "") return release;
	const prerelease = /^-(alpha|beta|rc)\.?(\d+)$/.exec(suffix);
	const label = prerelease?.[1];
	if (prerelease === null || label === undefined)
		throw new ForgeError(
			`version ${version} has a prerelease label PEP 440 cannot express (${suffix.replace(/^-/, "")}); use -alpha.N, -beta.N or -rc.N`,
		);
	return `${release}${PEP_440_PRERELEASES[label]}${prerelease[2]}`;
}

/**
 * The platform tag of the fallback wheel, which ships no binary. Installers
 * rank `py3-none-any` below every platform tag, so they pick it only on a
 * platform no target wheel fits (musl Linux, Windows on Arm, …), where its
 * console entry names the platform and points at install.sh.
 */
export const FALLBACK_WHEEL_TAG = "any";

function wheelName(version: string, platformTag: string): string {
	return `llm_tests_forge-${pep440Version(version)}-py3-none-${platformTag}.whl`;
}

/** The file name `uv build --wheel` gives the wheel of one target. */
export function wheelFileName(version: string, target: ReleaseTarget): string {
	return wheelName(version, target.wheelTag);
}

/** The file name `uv build --wheel` gives the fallback wheel. */
export function fallbackWheelFileName(version: string): string {
	return wheelName(version, FALLBACK_WHEEL_TAG);
}

/**
 * The release version, once pyproject.toml carries it and the wheels can:
 * a stale manifest, a version PEP 440 cannot express and a missing LICENSE
 * (which the build hook copies in) are each refused before anything is built.
 */
async function stampedVersion(root: string): Promise<string> {
	const stale = await checkVersions(root, PYPI_MANIFESTS);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${await releaseVersion(root)} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	const version = await releaseVersion(root);
	pep440Version(version);
	await licensePath(root);
	return version;
}

/**
 * Runs `uv build --wheel` on `packages/pypi` into `absoluteOut` with
 * `platformTag` and `binary` in the two variables the build hook reads; with
 * no binary, the variable is removed from the inherited environment, so the
 * hook builds the fallback. Returns the path of the wheel, `wheel`.
 */
async function buildWheel(
	root: string,
	uvCommand: string,
	absoluteOut: string,
	platformTag: string,
	binary: string | undefined,
	wheel: string,
): Promise<string> {
	const { FORGE_WHEEL_BINARY: _inherited, ...inheritedEnvironment } =
		process.env;
	const child = Bun.spawn(
		[
			uvCommand,
			"build",
			"--wheel",
			"--out-dir",
			absoluteOut,
			join(root, "packages/pypi"),
		],
		{
			env: {
				...inheritedEnvironment,
				FORGE_WHEEL_PLATFORM: platformTag,
				...(binary === undefined ? {} : { FORGE_WHEEL_BINARY: binary }),
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
			`uv build failed for ${platformTag} (exit ${exitCode}): ${stderr.trim()}`,
			{ file: wheel },
		);
	if (!(await Bun.file(wheel).exists()))
		throw new ForgeError("uv build did not write the wheel", { file: wheel });
	return wheel;
}

/**
 * Builds one wheel per target into `outDirectory` by running `uv build
 * --wheel` on `packages/pypi` with the target's platform tag and binary in
 * the two variables the build hook reads; returns the wheel paths in target
 * order. The wheels carry the version of the committed pyproject.toml, which
 * must be stamped. `uvCommand` and `targets` exist for the tests.
 */
export async function renderWheels(
	binariesDirectory: string,
	outDirectory: string,
	root: string = REPOSITORY_ROOT,
	uvCommand = "uv",
	targets: readonly ReleaseTarget[] = RELEASE_TARGETS,
): Promise<string[]> {
	const version = await stampedVersion(root);
	for (const target of targets) {
		const source = join(binariesDirectory, target.assetName);
		if (!(await Bun.file(source).exists()))
			throw new ForgeError("release binary is missing", { file: source });
	}
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	const written: string[] = [];
	for (const target of targets)
		written.push(
			await buildWheel(
				root,
				uvCommand,
				absoluteOut,
				target.wheelTag,
				resolve(binariesDirectory, target.assetName),
				join(absoluteOut, wheelFileName(version, target)),
			),
		);
	return written;
}

/**
 * Builds the fallback wheel (`py3-none-any`, no binary) into `outDirectory`
 * from the same `packages/pypi`, so it carries the same stamped version;
 * returns its path. `uvCommand` exists for the tests.
 */
export async function renderFallbackWheel(
	outDirectory: string,
	root: string = REPOSITORY_ROOT,
	uvCommand = "uv",
): Promise<string> {
	const version = await stampedVersion(root);
	const absoluteOut = resolve(outDirectory);
	await mkdir(absoluteOut, { recursive: true });
	return buildWheel(
		root,
		uvCommand,
		absoluteOut,
		FALLBACK_WHEEL_TAG,
		undefined,
		join(absoluteOut, fallbackWheelFileName(version)),
	);
}

/** `wheels.ts <binaries-directory> <out-directory>`: returns the exit code. */
export async function runWheels(
	argumentsList: string[],
	print: (line: string) => void,
): Promise<number> {
	const [binariesDirectory, outDirectory, ...extra] = argumentsList;
	if (
		binariesDirectory === undefined ||
		outDirectory === undefined ||
		extra.length > 0
	)
		throw new UsageError(
			"usage: wheels.ts <binaries-directory> <out-directory>",
		);
	for (const wheel of await renderWheels(binariesDirectory, outDirectory))
		print(wheel);
	return 0;
}

await runMain(import.meta.main, runWheels);
