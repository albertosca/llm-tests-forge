import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { RELEASE_TARGETS, type ReleaseTarget } from "./targets";
import { checkVersions, PYPI_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** The file name `uv build --wheel` gives the wheel of one target. */
export function wheelFileName(version: string, target: ReleaseTarget): string {
	return `llm_tests_forge-${version}-py3-none-${target.wheelTag}.whl`;
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
	const stale = await checkVersions(root, PYPI_MANIFESTS);
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
					...process.env,
					FORGE_WHEEL_PLATFORM: target.wheelTag,
					FORGE_WHEEL_BINARY: resolve(binariesDirectory, target.assetName),
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
		const wheel = join(absoluteOut, wheelFileName(version, target));
		if (exitCode !== 0)
			throw new ForgeError(
				`uv build failed for ${target.wheelTag} (exit ${exitCode}): ${stderr.trim()}`,
				{ file: wheel },
			);
		if (!(await Bun.file(wheel).exists()))
			throw new ForgeError("uv build did not write the wheel", { file: wheel });
		written.push(wheel);
	}
	return written;
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
