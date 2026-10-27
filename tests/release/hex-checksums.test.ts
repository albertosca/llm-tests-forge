import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	renderHexChecksums,
	runHexChecksums,
} from "../../scripts/release/hex-checksums";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
	checkVersions,
	HEX_MANIFESTS,
	MANIFESTS,
} from "../../scripts/release/version";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");

describe("the Hex package's documentation", () => {
	test("the moduledoc shows the dependency line both install guides show: dev only, not at runtime", async () => {
		const dependency =
			'{:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}';
		for (const path of [
			"packages/hex/lib/llm_tests_forge.ex",
			"guide/en/install.md",
			"guide/pt/install.md",
		])
			expect({
				path,
				shown: (await readFile(join(REPOSITORY, path), "utf8")).includes(
					dependency,
				),
			}).toEqual({ path, shown: true });
	});
});

/** A repository root holding a copy of the committed Hex package and a package.json at `version`. */
async function rootWithHexPackage(version = FORGE_VERSION): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-hex-root-"));
	await mkdir(join(root, "packages"), { recursive: true });
	await cp(join(REPOSITORY, "packages/hex"), join(root, "packages/hex"), {
		recursive: true,
	});
	await writeFile(join(root, "package.json"), `{ "version": "${version}" }\n`);
	return root;
}

/** A SHA256SUMS whose hash for each asset is its position, so a swapped line shows. */
async function sumsDirectory(
	transform: (lines: string[]) => string[] = (lines) => lines,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-hex-sums-"));
	const lines = RELEASE_TARGETS.map(
		(target, index) =>
			`${String(index + 1)
				.repeat(64)
				.slice(0, 64)}  ${target.assetName}`,
	).sort((first, second) => first.slice(66).localeCompare(second.slice(66)));
	await writeFile(
		join(directory, "SHA256SUMS"),
		`${transform(lines).join("\n")}\n`,
	);
	return directory;
}

describe("the hex manifest", () => {
	test("mix.exs is in the stamped list with a text pattern", () => {
		const registered = MANIFESTS.filter((manifest) =>
			manifest.path.startsWith("packages/hex/"),
		);
		expect(registered).toEqual([...HEX_MANIFESTS]);
		expect(registered.map((manifest) => manifest.path)).toEqual([
			"packages/hex/mix.exs",
		]);
		expect(registered[0]?.format).toBe("text");
	});

	test("a mix.exs left at another version is named by the check, and only the line-anchored version counts", async () => {
		const root = await rootWithHexPackage();
		const path = join(root, "packages/hex/mix.exs");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			`# elixir requirement, not version: "1.2.3"\n${text.replace(`version: "${FORGE_VERSION}"`, 'version: "0.0.9"')}`,
		);
		expect(await checkVersions(root, HEX_MANIFESTS)).toEqual([
			{ path: "packages/hex/mix.exs", found: "0.0.9" },
		]);
	});

	test("the Elixir module knows an asset name for each release target, and only those", async () => {
		const source = await readFile(
			join(REPOSITORY, "packages/hex/lib/llm_tests_forge.ex"),
			"utf8",
		);
		const listed = [...source.matchAll(/=> "(llm-tests-forge-[^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(listed.sort()).toEqual(
			RELEASE_TARGETS.map((target) => target.assetName).sort(),
		);
		for (const target of RELEASE_TARGETS)
			expect(source).toContain(
				`"${target.npmOs}-${target.npmCpu}" => "${target.assetName}"`,
			);
	});
});

describe("hex checksums", () => {
	test("writes an Elixir map of every asset's hash, sorted by name, with the version in its header", async () => {
		const root = await rootWithHexPackage();
		const sums = await sumsDirectory();
		const written = await renderHexChecksums(sums, root);
		expect(written).toBe(join(root, "packages/hex/checksums.exs"));
		const expectedEntries = RELEASE_TARGETS.map((target) => ({
			name: target.assetName,
			hash: `${String(RELEASE_TARGETS.indexOf(target) + 1).repeat(64)}`,
		}))
			.sort((first, second) => first.name.localeCompare(second.name))
			.map(({ name, hash }) => `  "${name}" => "${hash}"`)
			.join(",\n");
		expect(await readFile(written, "utf8")).toBe(
			`# SHA256 of each release binary of v${FORGE_VERSION}, written at release time by scripts/release/hex-checksums.ts from SHA256SUMS.\n%{\n${expectedEntries}\n}\n`,
		);
	});

	test("a mix.exs left at another version refuses the render, naming it and the stamp command", async () => {
		const root = await rootWithHexPackage();
		const path = join(root, "packages/hex/mix.exs");
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace(
				`version: "${FORGE_VERSION}"`,
				'version: "0.0.9"',
			),
		);
		await expect(
			renderHexChecksums(await sumsDirectory(), root),
		).rejects.toThrow(
			`not stamped with ${FORGE_VERSION} (run release:stamp): packages/hex/mix.exs has 0.0.9`,
		);
	});

	test("an unreadable SHA256SUMS is refused naming its path", async () => {
		const root = await rootWithHexPackage();
		const empty = await mkdtemp(join(tmpdir(), "forge-hex-empty-"));
		await expect(renderHexChecksums(empty, root)).rejects.toThrow(
			`SHA256SUMS cannot be read (file: ${join(empty, "SHA256SUMS")})`,
		);
	});

	test("a malformed line is refused, quoted", async () => {
		const root = await rootWithHexPackage();
		const sums = await sumsDirectory((lines) => [...lines, "nothex  asset"]);
		await expect(renderHexChecksums(sums, root)).rejects.toThrow(
			"malformed line: nothex  asset",
		);
	});

	test("a release asset missing from SHA256SUMS is refused, named", async () => {
		const root = await rootWithHexPackage();
		const sums = await sumsDirectory((lines) =>
			lines.filter((line) => !line.endsWith("llm-tests-forge-linux-x64")),
		);
		await expect(renderHexChecksums(sums, root)).rejects.toThrow(
			"SHA256SUMS does not list llm-tests-forge-linux-x64",
		);
	});

	test("the command prints the file it wrote to the package, and anything but one argument is a usage error", async () => {
		const root = await rootWithHexPackage();
		const sums = await sumsDirectory();
		const printed: string[] = [];
		expect(
			await runHexChecksums([sums], (line) => printed.push(line), root),
		).toBe(0);
		expect(printed).toEqual([join(root, "packages/hex/checksums.exs")]);
		for (const argumentsList of [[], ["a", "b"]])
			await expect(
				runHexChecksums(argumentsList, () => {}, root),
			).rejects.toBeInstanceOf(UsageError);
	});

	test("the output path can be given, and the template carries both placeholders", async () => {
		const root = await rootWithHexPackage();
		const sums = await sumsDirectory();
		const target = join(root, "elsewhere.exs");
		expect(await renderHexChecksums(sums, root, target)).toBe(target);
		const template = await readFile(
			join(REPOSITORY, "packages/hex/checksums.exs.tmpl"),
			"utf8",
		);
		expect(template).toContain("{{VERSION}}");
		expect(template).toContain("{{CHECKSUMS}}");
	});
});
