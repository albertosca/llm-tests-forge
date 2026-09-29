import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	defaultBaseUrl,
	renderFormula,
	runHomebrewFormula,
} from "../../scripts/release/homebrew-formula";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
	checkVersions,
	HOMEBREW_MANIFESTS,
	MANIFESTS,
} from "../../scripts/release/version";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");
const TEMPLATE = "packages/homebrew/llm-tests-forge.rb.tmpl";
const SUMS_PATH = "/somewhere/SHA256SUMS";

/** A SHA256SUMS text whose hash for each asset is its position, so a swapped line shows. */
function sumsText(skip: string[] = []): string {
	return `${RELEASE_TARGETS.map(
		(target, index) => `${String(index + 1).repeat(64)}  ${target.assetName}`,
	)
		.filter((line) => !skip.some((name) => line.endsWith(name)))
		.join("\n")}\n`;
}

/** A repository root holding a copy of the committed formula template. */
async function rootWithTemplate(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-brew-root-"));
	await mkdir(join(root, "packages/homebrew"), { recursive: true });
	await cp(join(REPOSITORY, TEMPLATE), join(root, TEMPLATE));
	return root;
}

describe("the homebrew manifest", () => {
	test("the formula template is in the stamped list with a text pattern", () => {
		const registered = MANIFESTS.filter((manifest) =>
			manifest.path.startsWith("packages/homebrew/"),
		);
		expect(registered).toEqual([...HOMEBREW_MANIFESTS]);
		expect(registered.map((manifest) => manifest.path)).toEqual([TEMPLATE]);
		expect(registered[0]?.format).toBe("text");
	});

	test("a template left at another version is named by the check, and only the line-anchored version counts", async () => {
		const root = await rootWithTemplate();
		await writeFile(
			join(root, "package.json"),
			`{ "version": "${FORGE_VERSION}" }\n`,
		);
		const path = join(root, TEMPLATE);
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			`# not the version: version "1.2.3"\n${text.replace(`version "${FORGE_VERSION}"`, 'version "0.0.9"')}`,
		);
		expect(await checkVersions(root, HOMEBREW_MANIFESTS)).toEqual([
			{ path: TEMPLATE, found: "0.0.9" },
		]);
	});
});

describe("the formula", () => {
	test("has a url and sha256 for each Homebrew target under its os and arch block, installs that asset as llm-tests-forge, and has no Windows asset", async () => {
		const formula = await renderFormula(
			FORGE_VERSION,
			sumsText(),
			SUMS_PATH,
			"http://127.0.0.1:1234",
		);
		expect(formula).not.toContain("{{");
		expect(formula).not.toContain("windows");
		for (const target of RELEASE_TARGETS) {
			if (target.homebrew === null) continue;
			const index = RELEASE_TARGETS.indexOf(target) + 1;
			const hash = String(index).repeat(64);
			const [declarations = "", installation = ""] =
				formula.split("  def install");
			// The text of the `on_<os>` block at its own indentation, up to its closing `end`.
			const section = (text: string, indentation: string) =>
				text
					.split(`${indentation}on_${target.homebrew?.os} do\n`)[1]
					?.split(`\n${indentation}end\n`)[0] ?? "";
			expect(section(declarations, "  ")).toMatch(
				new RegExp(
					`on_${target.homebrew.arch} do\\n\\s+url "http://127.0.0.1:1234/${target.assetName}"\\n\\s+sha256 "${hash}"\\n\\s+end`,
				),
			);
			expect(section(installation, "    ")).toMatch(
				new RegExp(
					`on_${target.homebrew.arch} do\\n\\s+bin.install "${target.assetName}" => "llm-tests-forge"\\n\\s+end`,
				),
			);
		}
		expect(formula).toContain(
			'shell_output("#{bin}/llm-tests-forge --version")',
		);
		expect(formula).toContain(`version "${FORGE_VERSION}"`);
	});

	test("the base URL defaults to the GitHub Release of that version and a trailing slash is dropped from another", async () => {
		expect(defaultBaseUrl("1.2.3")).toBe(
			"https://github.com/albertosca/llm-tests-forge/releases/download/v1.2.3",
		);
		const defaulted = await renderFormula(FORGE_VERSION, sumsText(), SUMS_PATH);
		expect(defaulted).toContain(
			`url "${defaultBaseUrl(FORGE_VERSION)}/llm-tests-forge-darwin-arm64"`,
		);
		const slashed = await renderFormula(
			FORGE_VERSION,
			sumsText(),
			SUMS_PATH,
			"http://host/dir//",
		);
		expect(slashed).toContain(
			'url "http://host/dir/llm-tests-forge-darwin-arm64"',
		);
	});

	test("a version other than the template's is refused, naming the template and the stamp command", async () => {
		await expect(renderFormula("9.9.9", sumsText(), SUMS_PATH)).rejects.toThrow(
			`template is stamped ${FORGE_VERSION}, not 9.9.9 (run release:stamp)`,
		);
		const root = await rootWithTemplate();
		await writeFile(join(root, TEMPLATE), "class Nothing < Formula\nend\n");
		await expect(
			renderFormula(FORGE_VERSION, sumsText(), SUMS_PATH, undefined, root),
		).rejects.toThrow(
			`template is stamped with no version, not ${FORGE_VERSION}`,
		);
	});

	test("a Homebrew asset missing from SHA256SUMS is refused, named; the Windows asset is not needed", async () => {
		await expect(
			renderFormula(
				FORGE_VERSION,
				sumsText(["llm-tests-forge-linux-arm64"]),
				SUMS_PATH,
			),
		).rejects.toThrow("SHA256SUMS does not list llm-tests-forge-linux-arm64");
		expect(
			await renderFormula(
				FORGE_VERSION,
				sumsText(["llm-tests-forge-windows-x64.exe"]),
				SUMS_PATH,
			),
		).toContain("sha256");
	});

	test("a template placeholder that names an asset SHA256SUMS does not list is refused, not left as a hole", async () => {
		const root = await rootWithTemplate();
		const path = join(root, TEMPLATE);
		await writeFile(
			path,
			`${await readFile(path, "utf8")}# {{SHA256:llm-tests-forge-freebsd-x64}}\n`,
		);
		await expect(
			renderFormula(FORGE_VERSION, sumsText(), SUMS_PATH, undefined, root),
		).rejects.toThrow(
			"template names llm-tests-forge-freebsd-x64, which SHA256SUMS does not list",
		);
	});

	test("an unreadable template is refused naming its path", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-brew-empty-"));
		await expect(
			renderFormula(FORGE_VERSION, sumsText(), SUMS_PATH, undefined, root),
		).rejects.toThrow(
			`formula template cannot be read (file: ${join(root, TEMPLATE)})`,
		);
	});
});

describe("the command", () => {
	test("prints the formula for a SHA256SUMS file and a base URL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-brew-sums-"));
		const sumsPath = join(directory, "SHA256SUMS");
		await writeFile(sumsPath, sumsText());
		const printed: string[] = [];
		expect(
			await runHomebrewFormula(
				[FORGE_VERSION, sumsPath, "http://127.0.0.1:9"],
				(line) => printed.push(line),
			),
		).toBe(0);
		expect(printed).toHaveLength(1);
		expect(printed[0]).toContain(
			'url "http://127.0.0.1:9/llm-tests-forge-linux-x64"',
		);
		expect(printed[0]?.endsWith("end")).toBe(true);
	});

	test("anything but two or three arguments is a usage error, and an unreadable SHA256SUMS names its path", async () => {
		for (const argumentsList of [[], ["1.0.0"], ["1", "b", "c", "d"]])
			await expect(
				runHomebrewFormula(argumentsList, () => {}),
			).rejects.toBeInstanceOf(UsageError);
		await expect(
			runHomebrewFormula([FORGE_VERSION, "/nonexistent/SHA256SUMS"], () => {}),
		).rejects.toThrow(
			"SHA256SUMS cannot be read (file: /nonexistent/SHA256SUMS)",
		);
	});
});
