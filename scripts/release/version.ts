import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { RELEASE_TARGETS } from "./targets";

/**
 * One file that carries the release version. `pattern` finds the version in
 * the file's text: group 1 is what precedes it, group 2 the version itself,
 * group 3 what follows. A JSON manifest is also read by parsing, so a
 * "version" key nested deeper than the top level cannot be mistaken for it.
 */
export interface Manifest {
	path: string;
	format: "json" | "text";
	pattern: RegExp;
}

const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;

/**
 * The npm packages' manifests: the main package's own version, each of its
 * optionalDependencies on a platform package (one line each, so a stale one
 * is named), and the platform package template.
 */
export const NPM_MANIFESTS: readonly Manifest[] = [
	{
		path: "packages/npm/main/package.json",
		format: "json",
		pattern: JSON_VERSION,
	},
	...RELEASE_TARGETS.map(
		(target): Manifest => ({
			path: "packages/npm/main/package.json",
			format: "text",
			pattern: new RegExp(
				`^(\\s*"@llm-tests-forge/${target.npmOs}-${target.npmCpu}"\\s*:\\s*")([^"]*)(")`,
				"m",
			),
		}),
	),
	{
		path: "packages/npm/platform/package.json.tmpl",
		format: "json",
		pattern: JSON_VERSION,
	},
];

/** The wheel package's manifest: the `version = "…"` line under `[project]` (the file has no other line that starts that way). */
export const PYPI_MANIFESTS: readonly Manifest[] = [
	{
		path: "packages/pypi/pyproject.toml",
		format: "text",
		pattern: /^(version = ")([^"]*)(")/m,
	},
];

/** The Hex package's manifest: the `version: "…"` line in `project/0` (the only line of mix.exs that starts that way). */
export const HEX_MANIFESTS: readonly Manifest[] = [
	{
		path: "packages/hex/mix.exs",
		format: "text",
		pattern: /^(\s*version: ")([^"]*)(")/m,
	},
];

/**
 * Every package manifest, relative to the repository root. Each packaging
 * task adds its own files here as it creates them.
 */
export const MANIFESTS: readonly Manifest[] = [
	{
		path: "plugin/.claude-plugin/plugin.json",
		format: "json",
		pattern: JSON_VERSION,
	},
	...NPM_MANIFESTS,
	...PYPI_MANIFESTS,
	...HEX_MANIFESTS,
];

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

function versionIn(manifest: Manifest, text: string): string | undefined {
	if (manifest.format === "json") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}
		const version =
			typeof parsed === "object" && parsed !== null && "version" in parsed
				? parsed.version
				: undefined;
		return typeof version === "string" ? version : undefined;
	}
	return manifest.pattern.exec(text)?.[2];
}

/** The version `package.json` declares: the one every manifest must carry. */
export async function releaseVersion(
	root: string = REPOSITORY_ROOT,
): Promise<string> {
	const path = join(root, "package.json");
	const version = versionIn(
		{ path: "package.json", format: "json", pattern: JSON_VERSION },
		await readFile(path, "utf8"),
	);
	if (version === undefined || version === "")
		throw new ForgeError("package.json has no version", { file: path });
	return version;
}

async function readManifest(root: string, manifest: Manifest) {
	try {
		return await readFile(join(root, manifest.path), "utf8");
	} catch {
		throw new ForgeError("manifest cannot be read", {
			file: join(root, manifest.path),
		});
	}
}

/** Writes `package.json`'s version into every manifest; returns the paths whose text changed. */
export async function stampVersion(
	root: string = REPOSITORY_ROOT,
	manifests: readonly Manifest[] = MANIFESTS,
): Promise<string[]> {
	const version = await releaseVersion(root);
	const changed: string[] = [];
	for (const manifest of manifests) {
		const text = await readManifest(root, manifest);
		const stamped = text.replace(
			manifest.pattern,
			(_match, before: string, _old: string, after: string) =>
				`${before}${version}${after}`,
		);
		if (versionIn(manifest, stamped) !== version)
			throw new ForgeError(`no version to stamp (expected ${version})`, {
				file: join(root, manifest.path),
			});
		if (stamped === text) continue;
		await writeFile(join(root, manifest.path), stamped);
		if (!changed.includes(manifest.path)) changed.push(manifest.path);
	}
	return changed;
}

/** A manifest whose version is not `package.json`'s (`found` is undefined when the file carries none). */
export interface VersionDisagreement {
	path: string;
	found: string | undefined;
}

/** Lists every manifest whose version differs from `package.json`'s; a missing file is an error, not a disagreement. */
export async function checkVersions(
	root: string = REPOSITORY_ROOT,
	manifests: readonly Manifest[] = MANIFESTS,
): Promise<VersionDisagreement[]> {
	const version = await releaseVersion(root);
	const disagreements: VersionDisagreement[] = [];
	for (const manifest of manifests) {
		const found = versionIn(manifest, await readManifest(root, manifest));
		if (found !== version) disagreements.push({ path: manifest.path, found });
	}
	return disagreements;
}

/** `version.ts stamp|check`: `check` exits 1 listing each manifest that disagrees. */
export async function runVersion(
	argumentsList: string[],
	print: (line: string) => void,
	root: string = REPOSITORY_ROOT,
	manifests: readonly Manifest[] = MANIFESTS,
): Promise<number> {
	const [command, ...extra] = argumentsList;
	if ((command !== "stamp" && command !== "check") || extra.length > 0)
		throw new UsageError("usage: version.ts stamp|check");
	if (command === "stamp") {
		const changed = await stampVersion(root, manifests);
		print(
			`stamped ${await releaseVersion(root)} into ${changed.length} of ${new Set(manifests.map((manifest) => manifest.path)).size} manifests`,
		);
		return 0;
	}
	const disagreements = await checkVersions(root, manifests);
	if (disagreements.length === 0) return 0;
	const expected = await releaseVersion(root);
	for (const { path, found } of disagreements)
		print(`${path}: ${found ?? "no version"} (package.json: ${expected})`);
	return 1;
}

await runMain(import.meta.main, runVersion);
