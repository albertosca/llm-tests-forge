import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { parseChecksums } from "./hex-checksums";
import { RELEASE_TARGETS } from "./targets";
import { HOMEBREW_FORMULA_MANIFEST, versionIn } from "./version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const FORMULA_TEMPLATE = "packages/homebrew/llm-tests-forge.rb.tmpl";

/** Where the assets of release `version` are downloaded from unless the caller gives another base URL. */
export function defaultBaseUrl(version: string): string {
	return `https://github.com/albertosca/llm-tests-forge/releases/download/v${version}`;
}

/**
 * Renders the Homebrew formula for `version` from the template: every
 * `{{BASE_URL}}` becomes `baseUrl` (no trailing slash) and every
 * `{{SHA256:<asset>}}` the hash `SHA256SUMS` (`sumsText`) records for that
 * asset. The template's own version line must already be `version`, and every
 * asset a Homebrew target ships must be listed. A placeholder that the
 * template names and the sums do not answer is refused, so no formula is ever
 * written with a hole in it.
 */
export async function renderFormula(
	version: string,
	sumsText: string,
	sumsPath: string,
	baseUrl: string = defaultBaseUrl(version),
	root: string = REPOSITORY_ROOT,
): Promise<string> {
	const templatePath = join(root, FORMULA_TEMPLATE);
	let template: string;
	try {
		template = await readFile(templatePath, "utf8");
	} catch {
		throw new ForgeError("formula template cannot be read", {
			file: templatePath,
		});
	}
	const stamped = versionIn(HOMEBREW_FORMULA_MANIFEST, template);
	if (stamped !== version)
		throw new ForgeError(
			`template is stamped ${stamped ?? "with no version"}, not ${version} (run release:stamp)`,
			{ file: templatePath },
		);
	const checksums = parseChecksums(sumsText, sumsPath);
	const unlisted = RELEASE_TARGETS.filter((target) => target.homebrew !== null)
		.map((target) => target.assetName)
		.filter((assetName) => !checksums.has(assetName));
	if (unlisted.length > 0)
		throw new ForgeError(`SHA256SUMS does not list ${unlisted.join(", ")}`, {
			file: sumsPath,
		});
	return template
		.replaceAll("{{BASE_URL}}", () => baseUrl.replace(/\/+$/, ""))
		.replaceAll(/\{\{SHA256:([^}]*)\}\}/g, (_match, assetName: string) => {
			const hash = checksums.get(assetName);
			if (hash === undefined)
				throw new ForgeError(
					`template names ${assetName}, which SHA256SUMS does not list`,
					{
						file: sumsPath,
					},
				);
			return hash;
		});
}

/** `homebrew-formula.ts <version> <SHA256SUMS> [<base-url>]`: prints the formula, returns the exit code. */
export async function runHomebrewFormula(
	argumentsList: string[],
	print: (line: string) => void,
	root: string = REPOSITORY_ROOT,
): Promise<number> {
	const [version, sumsPath, baseUrl, ...extra] = argumentsList;
	if (version === undefined || sumsPath === undefined || extra.length > 0)
		throw new UsageError(
			"usage: homebrew-formula.ts <version> <SHA256SUMS> [<base-url>]",
		);
	let sumsText: string;
	try {
		sumsText = await readFile(sumsPath, "utf8");
	} catch {
		throw new ForgeError("SHA256SUMS cannot be read", { file: sumsPath });
	}
	print(
		(await renderFormula(version, sumsText, sumsPath, baseUrl, root)).trimEnd(),
	);
	return 0;
}

await runMain(import.meta.main, runHomebrewFormula);
