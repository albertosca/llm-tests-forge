import {
	chmod,
	copyFile,
	cp,
	mkdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { RELEASE_TARGETS, type ReleaseTarget } from "./targets";
import { checkVersions, NPM_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** The name the launcher looks for inside a platform package, whatever the asset is called on the release. */
function binaryNameFor(target: ReleaseTarget): string {
	return target.npmOs === "win32" ? "llm-tests-forge.exe" : "llm-tests-forge";
}

/** The directory name of a platform package under the output directory. */
export function platformDirectoryName(target: ReleaseTarget): string {
	return `${target.npmOs}-${target.npmCpu}`;
}

function fillTemplate(text: string, values: Record<string, string>): string {
	return text.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => {
		const value = values[key];
		if (value === undefined)
			throw new ForgeError(
				`template has an unknown placeholder ${placeholder}`,
			);
		return value;
	});
}

/**
 * Writes one package per release target under `outDirectory/<os>-<cpu>/`
 * (the template's package.json plus `bin/<binary>` copied from the asset,
 * executable) and a copy of the main package under `outDirectory/main/`;
 * returns the directories written, main first. The packages carry the
 * version of the committed manifests, which must all be stamped.
 */
export async function renderNpmPackages(
	binariesDirectory: string,
	outDirectory: string,
	root: string = REPOSITORY_ROOT,
): Promise<string[]> {
	const stale = await checkVersions(root, NPM_MANIFESTS);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${await releaseVersion(root)} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	const templatePath = join(root, "packages/npm/platform/package.json.tmpl");
	const template = await readFile(templatePath, "utf8");
	for (const target of RELEASE_TARGETS) {
		const source = join(binariesDirectory, target.assetName);
		if (!(await Bun.file(source).exists()))
			throw new ForgeError("release binary is missing", { file: source });
	}
	const absoluteOut = resolve(outDirectory);
	const mainDirectory = join(absoluteOut, "main");
	await mkdir(absoluteOut, { recursive: true });
	await cp(join(root, "packages/npm/main"), mainDirectory, { recursive: true });
	const written = [mainDirectory];
	for (const target of RELEASE_TARGETS) {
		const directory = join(absoluteOut, platformDirectoryName(target));
		const binaryName = binaryNameFor(target);
		await mkdir(join(directory, "bin"), { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			fillTemplate(template, {
				os: target.npmOs,
				cpu: target.npmCpu,
				binary: binaryName,
			}),
		);
		const destination = join(directory, "bin", binaryName);
		await copyFile(join(binariesDirectory, target.assetName), destination);
		await chmod(destination, 0o755);
		written.push(directory);
	}
	return written;
}

/** `npm-packages.ts <binaries-directory> <out-directory>`: returns the exit code. */
export async function runNpmPackages(
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
			"usage: npm-packages.ts <binaries-directory> <out-directory>",
		);
	for (const directory of await renderNpmPackages(
		binariesDirectory,
		outDirectory,
	))
		print(directory);
	return 0;
}

await runMain(import.meta.main, runNpmPackages);
