import { describe, expect, test } from "bun:test";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	renderNpmPackages,
	runNpmPackages,
} from "../../scripts/release/npm-packages";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
	checkVersions,
	MANIFESTS,
	NPM_MANIFESTS,
} from "../../scripts/release/version";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");

/** A repository root holding a copy of the committed npm packages and a package.json at `version`. */
async function rootWithNpmPackages(version = FORGE_VERSION): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-npm-root-"));
	await mkdir(join(root, "packages"), { recursive: true });
	await cp(join(REPOSITORY, "packages/npm"), join(root, "packages/npm"), {
		recursive: true,
	});
	await writeFile(join(root, "package.json"), `{ "version": "${version}" }\n`);
	return root;
}

async function fakeBinaries(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-npm-binaries-"));
	for (const target of RELEASE_TARGETS)
		await writeFile(
			join(directory, target.assetName),
			`#!/bin/sh\n# ${target.assetName}\n`,
			{
				mode: 0o644,
			},
		);
	return directory;
}

describe("the npm manifests", () => {
	test("the main package's version, each optional dependency and the platform template are all in the stamped list", () => {
		const registered = MANIFESTS.filter((manifest) =>
			manifest.path.startsWith("packages/npm/"),
		);
		expect(registered).toEqual([...NPM_MANIFESTS]);
		expect(registered.map((manifest) => manifest.path)).toEqual([
			"packages/npm/main/package.json",
			...RELEASE_TARGETS.map(() => "packages/npm/main/package.json"),
			"packages/npm/platform/package.json.tmpl",
		]);
	});

	test("an optional dependency left at another version is named by the check, and the pattern is line-anchored to that dependency", async () => {
		const root = await rootWithNpmPackages();
		const path = join(root, "packages/npm/main/package.json");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			text.replace(
				'"@llm-tests-forge/linux-arm64": "0.1.0"',
				'"@llm-tests-forge/linux-arm64": "0.0.9"',
			),
		);
		expect(await checkVersions(root, NPM_MANIFESTS)).toEqual([
			{ path: "packages/npm/main/package.json", found: "0.0.9" },
		]);
	});
});

describe("npm-packages", () => {
	test("writes a main package copy and one platform package per target, each at the stamped version with its binary executable", async () => {
		const binaries = await fakeBinaries();
		const out = join(await mkdtemp(join(tmpdir(), "forge-npm-out-")), "npm");
		const written = await renderNpmPackages(binaries, out);
		expect(written).toEqual([
			join(out, "main"),
			...RELEASE_TARGETS.map((target) =>
				join(out, `${target.npmOs}-${target.npmCpu}`),
			),
		]);
		const main = JSON.parse(
			await readFile(join(out, "main/package.json"), "utf8"),
		);
		expect(main.version).toBe(FORGE_VERSION);
		expect(main.optionalDependencies).toEqual(
			Object.fromEntries(
				RELEASE_TARGETS.map((target) => [
					`@llm-tests-forge/${target.npmOs}-${target.npmCpu}`,
					FORGE_VERSION,
				]),
			),
		);
		for (const file of ["llm-tests-forge.js", "platform.js"])
			expect((await stat(join(out, "main/bin", file))).isFile()).toBe(true);
		for (const target of RELEASE_TARGETS) {
			const directory = join(out, `${target.npmOs}-${target.npmCpu}`);
			const binaryName =
				target.npmOs === "win32" ? "llm-tests-forge.exe" : "llm-tests-forge";
			expect(
				JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
			).toMatchObject({
				name: `@llm-tests-forge/${target.npmOs}-${target.npmCpu}`,
				version: FORGE_VERSION,
				os: [target.npmOs],
				cpu: [target.npmCpu],
				files: [`bin/${binaryName}`],
			});
			const binary = join(directory, "bin", binaryName);
			expect(await readFile(binary, "utf8")).toBe(
				`#!/bin/sh\n# ${target.assetName}\n`,
			);
			expect((await stat(binary)).mode & 0o755).toBe(0o755);
		}
	});

	test("a manifest left at another version refuses the render, naming it and the stamp command", async () => {
		const root = await rootWithNpmPackages("9.9.9");
		await expect(
			renderNpmPackages(await fakeBinaries(), join(root, "out"), root),
		).rejects.toThrow(
			`not stamped with 9.9.9 (run release:stamp): packages/npm/main/package.json has ${FORGE_VERSION}`,
		);
	});

	test("a missing release binary is refused naming its path, and nothing is written", async () => {
		const binaries = await mkdtemp(join(tmpdir(), "forge-npm-binaries-"));
		const out = join(await mkdtemp(join(tmpdir(), "forge-npm-out-")), "npm");
		await expect(renderNpmPackages(binaries, out)).rejects.toThrow(
			`release binary is missing (file: ${join(binaries, RELEASE_TARGETS[0]?.assetName ?? "")})`,
		);
		expect(await Bun.file(join(out, "main/package.json")).exists()).toBe(false);
	});

	test("a template placeholder nothing fills is refused", async () => {
		const root = await rootWithNpmPackages();
		const templatePath = join(root, "packages/npm/platform/package.json.tmpl");
		await writeFile(
			templatePath,
			(await readFile(templatePath, "utf8")).replace("{{cpu}}", "{{cpuu}}"),
		);
		await expect(
			renderNpmPackages(await fakeBinaries(), join(root, "out"), root),
		).rejects.toThrow("template has an unknown placeholder {{cpuu}}");
	});

	test("the command prints each directory it wrote, and anything but two arguments is a usage error", async () => {
		const out = join(await mkdtemp(join(tmpdir(), "forge-npm-out-")), "npm");
		const printed: string[] = [];
		expect(
			await runNpmPackages([await fakeBinaries(), out], (line) =>
				printed.push(line),
			),
		).toBe(0);
		expect(printed).toHaveLength(RELEASE_TARGETS.length + 1);
		expect(printed[0]).toBe(join(out, "main"));
		for (const argumentsList of [[], ["binaries"], ["a", "b", "c"]])
			await expect(
				runNpmPackages(argumentsList, () => {}),
			).rejects.toBeInstanceOf(UsageError);
	});
});
