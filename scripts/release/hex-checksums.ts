import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { CHECKSUMS_FILE_NAME, RELEASE_TARGETS } from "./targets";
import { checkVersions, HEX_MANIFESTS, releaseVersion } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const HEX_CHECKSUMS_TEMPLATE = "packages/hex/checksums.exs.tmpl";
const HEX_CHECKSUMS_OUTPUT = "packages/hex/checksums.exs";

/** Reads `SHA256SUMS` text into asset name → hex; a line that is not `<64 hex>  <name>` is refused. */
function parseChecksums(text: string, file: string): Map<string, string> {
	const checksums = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const expected = line.slice(0, 64);
		const name = line.slice(66);
		if (
			!/^[0-9a-f]{64}$/.test(expected) ||
			line.slice(64, 66) !== "  " ||
			name === ""
		)
			throw new ForgeError(`malformed line: ${line}`, { file });
		checksums.set(name, expected);
	}
	return checksums;
}

/**
 * Writes the Hex package's `checksums.exs` (an Elixir map, asset name →
 * SHA256) from the `SHA256SUMS` in `sumsDirectory`, through the package's
 * template. Every release asset must be listed, and mix.exs must already be
 * stamped with the release version. Returns the path written.
 */
export async function renderHexChecksums(
	sumsDirectory: string,
	root: string = REPOSITORY_ROOT,
	outputPath: string = join(root, HEX_CHECKSUMS_OUTPUT),
): Promise<string> {
	const stale = await checkVersions(root, HEX_MANIFESTS);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${await releaseVersion(root)} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	const sumsPath = join(sumsDirectory, CHECKSUMS_FILE_NAME);
	let sumsText: string;
	try {
		sumsText = await readFile(sumsPath, "utf8");
	} catch {
		throw new ForgeError(`${CHECKSUMS_FILE_NAME} cannot be read`, {
			file: sumsPath,
		});
	}
	const checksums = parseChecksums(sumsText, sumsPath);
	const unlisted = RELEASE_TARGETS.map((target) => target.assetName).filter(
		(assetName) => !checksums.has(assetName),
	);
	if (unlisted.length > 0)
		throw new ForgeError(
			`${CHECKSUMS_FILE_NAME} does not list ${unlisted.join(", ")}`,
			{ file: sumsPath },
		);
	const entries = RELEASE_TARGETS.map((target) => target.assetName)
		.sort()
		.map(
			(assetName) => `  "${assetName}" => "${checksums.get(assetName) ?? ""}"`,
		)
		.join(",\n");
	const version = await releaseVersion(root);
	const template = await readFile(join(root, HEX_CHECKSUMS_TEMPLATE), "utf8");
	await writeFile(
		outputPath,
		template
			.replace("{{VERSION}}", () => version)
			.replace("{{CHECKSUMS}}", () => entries),
	);
	return outputPath;
}

/** `hex-checksums.ts <directory-with-SHA256SUMS>`: writes `packages/hex/checksums.exs`, prints its path, returns the exit code. */
export async function runHexChecksums(
	argumentsList: string[],
	print: (line: string) => void,
	root: string = REPOSITORY_ROOT,
): Promise<number> {
	const [sumsDirectory, ...extra] = argumentsList;
	if (sumsDirectory === undefined || extra.length > 0)
		throw new UsageError("usage: hex-checksums.ts <directory-with-SHA256SUMS>");
	print(await renderHexChecksums(sumsDirectory, root));
	return 0;
}

await runMain(import.meta.main, runHexChecksums);
