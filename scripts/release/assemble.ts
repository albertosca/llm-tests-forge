import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { verifyChecksums } from "./checksums";
import { runMain } from "./entry";
import { renderFallbackGem, renderGems } from "./gems";
import { renderHexChecksums } from "./hex-checksums";
import { renderFormula } from "./homebrew-formula";
import { copyLicense } from "./license";
import { renderNpmPackages } from "./npm-packages";
import { CHECKSUMS_FILE_NAME, RELEASE_TARGETS } from "./targets";
import { checkVersions, releaseVersion } from "./version";
import { pep440Version, renderFallbackWheel, renderWheels } from "./wheels";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** What a local `mix` run leaves in `packages/hex`, and the checksums file rendered here; none of it is copied. */
const HEX_LOCAL_FILES = new Set([
	"_build",
	"deps",
	"erl_crash.dump",
	"checksums.exs",
]);

/** The commands and repository root `assembleRelease` uses; the tests replace them. */
export interface AssembleTools {
	uvCommand?: string;
	gemCommand?: string;
	root?: string;
}

/**
 * Turns a directory of downloaded release binaries (with their `SHA256SUMS`)
 * into every package the publish jobs upload, under `outDirectory`: `npm/`
 * (the main and platform packages), `wheels/`, `hex/` (a copy of the Hex
 * package with its `checksums.exs` rendered in and the LICENSE beside it), `gems/`,
 * `fallbacks/` (the `py3-none-any` wheel and the `ruby` gem, which ship no
 * binary; kept apart so the publish jobs upload them after every platform
 * package, since an installer takes a newer fallback over an older platform
 * package), and
 * `homebrew/llm-tests-forge.rb`. Nothing is written until the binaries match
 * `SHA256SUMS` and every manifest carries package.json's version. The
 * binaries are made executable first, since an artifact download drops the
 * bit and the wheels carry the file as it is. Returns the paths written.
 */
export async function assembleRelease(
	binariesDirectory: string,
	outDirectory: string,
	tools: AssembleTools = {},
): Promise<string[]> {
	const root = tools.root ?? REPOSITORY_ROOT;
	const mismatches = await verifyChecksums(binariesDirectory);
	if (mismatches.length > 0)
		throw new ForgeError(
			`the binaries do not match ${CHECKSUMS_FILE_NAME}: ${mismatches.map(({ name, reason }) => `${name} (${reason})`).join(", ")}`,
			{ file: join(binariesDirectory, mismatches[0]?.name ?? "") },
		);
	// SHA256SUMS vouches only for what it lists: a target absent from both it
	// and the directory is caught here, by name.
	for (const target of RELEASE_TARGETS) {
		const binary = join(binariesDirectory, target.assetName);
		if (!(await Bun.file(binary).exists()))
			throw new ForgeError("release binary is missing", { file: binary });
	}
	const version = await releaseVersion(root);
	const stale = await checkVersions(root);
	if (stale.length > 0)
		throw new ForgeError(
			`not stamped with ${version} (run release:stamp): ${stale.map(({ path, found }) => `${path} has ${found ?? "no version"}`).join(", ")}`,
			{ file: join(root, stale[0]?.path ?? "package.json") },
		);
	// A version the wheels cannot carry is refused before anything is written.
	pep440Version(version);
	for (const target of RELEASE_TARGETS)
		await chmod(join(binariesDirectory, target.assetName), 0o755);
	const absoluteOut = resolve(outDirectory);
	const npmDirectory = join(absoluteOut, "npm");
	const wheelsDirectory = join(absoluteOut, "wheels");
	const hexDirectory = join(absoluteOut, "hex");
	const gemsDirectory = join(absoluteOut, "gems");
	const fallbacksDirectory = join(absoluteOut, "fallbacks");
	const formulaPath = join(absoluteOut, "homebrew/llm-tests-forge.rb");
	await renderNpmPackages(binariesDirectory, npmDirectory, root);
	await renderWheels(binariesDirectory, wheelsDirectory, root, tools.uvCommand);
	await cp(join(root, "packages/hex"), hexDirectory, {
		recursive: true,
		filter: (source) => !HEX_LOCAL_FILES.has(basename(source)),
	});
	await copyLicense(root, hexDirectory);
	await renderHexChecksums(
		binariesDirectory,
		root,
		join(hexDirectory, "checksums.exs"),
	);
	await renderGems(binariesDirectory, gemsDirectory, root, tools.gemCommand);
	await renderFallbackWheel(fallbacksDirectory, root, tools.uvCommand);
	await renderFallbackGem(fallbacksDirectory, root, tools.gemCommand);
	const sumsPath = join(binariesDirectory, CHECKSUMS_FILE_NAME);
	const formula = await renderFormula(
		version,
		await readFile(sumsPath, "utf8"),
		sumsPath,
		undefined,
		root,
	);
	await mkdir(join(absoluteOut, "homebrew"), { recursive: true });
	await writeFile(formulaPath, formula);
	return [
		npmDirectory,
		wheelsDirectory,
		hexDirectory,
		gemsDirectory,
		fallbacksDirectory,
		formulaPath,
	];
}

/** `assemble.ts <binaries-directory> <out-directory>`: prints each path written, returns the exit code. */
export async function runAssemble(
	argumentsList: string[],
	print: (line: string) => void,
	tools: AssembleTools = {},
): Promise<number> {
	const [binariesDirectory, outDirectory, ...extra] = argumentsList;
	if (
		binariesDirectory === undefined ||
		outDirectory === undefined ||
		extra.length > 0
	)
		throw new UsageError(
			"usage: assemble.ts <binaries-directory> <out-directory>",
		);
	for (const path of await assembleRelease(
		binariesDirectory,
		outDirectory,
		tools,
	))
		print(path);
	return 0;
}

await runMain(import.meta.main, runAssemble);
