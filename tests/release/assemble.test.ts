import { describe, expect, test } from "bun:test";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleRelease, runAssemble } from "../../scripts/release/assemble";
import { writeChecksums } from "../../scripts/release/checksums";
import { gemFileName } from "../../scripts/release/gems";
import { platformDirectoryName } from "../../scripts/release/npm-packages";
import {
	CHECKSUMS_FILE_NAME,
	RELEASE_TARGETS,
} from "../../scripts/release/targets";
import { stampVersion } from "../../scripts/release/version";
import { wheelFileName } from "../../scripts/release/wheels";
import { ForgeError, UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");

/** Small files under the asset names, written without the exec bit (as an artifact download leaves them), with their SHA256SUMS. */
async function fakeBinaries(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-assemble-binaries-"));
	for (const target of RELEASE_TARGETS)
		await writeFile(
			join(directory, target.assetName),
			`# ${target.assetName}\n`,
			{ mode: 0o644 },
		);
	await writeChecksums(directory);
	return directory;
}

/** A repository root holding a copy of the committed packages and plugin manifest, and a package.json at `version`. */
async function rootCopy(version = FORGE_VERSION): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-assemble-root-"));
	await cp(join(REPOSITORY, "packages"), join(root, "packages"), {
		recursive: true,
	});
	await mkdir(join(root, "plugin"), { recursive: true });
	await cp(
		join(REPOSITORY, "plugin/.claude-plugin"),
		join(root, "plugin/.claude-plugin"),
		{ recursive: true },
	);
	await writeFile(join(root, "package.json"), `{ "version": "${version}" }\n`);
	await cp(join(REPOSITORY, "LICENSE"), join(root, "LICENSE"));
	return root;
}

/**
 * A stand-in for `uv` or `gem` that writes the file the real
 * `--out-dir`/`--output` would name. `wheelVersion` is the version as uv
 * spells it in the wheel name: the PEP 440 form, which for a prerelease is
 * not package.json's (uv writes 0.1.0-rc.1 as 0.1.0rc1, measured by the
 * package test in tests/packages/pypi.test.ts).
 */
async function fakeTools(
	wheelVersion = FORGE_VERSION,
): Promise<{ uvCommand: string; gemCommand: string }> {
	const directory = await mkdtemp(join(tmpdir(), "forge-assemble-tools-"));
	const uvCommand = join(directory, "uv");
	await writeFile(
		uvCommand,
		[
			"#!/bin/sh",
			'while [ "$#" -gt 0 ]; do',
			'  if [ "$1" = "--out-dir" ]; then out_directory="$2"; fi',
			"  shift",
			"done",
			`touch "$out_directory/llm_tests_forge-${wheelVersion}-py3-none-$FORGE_WHEEL_PLATFORM.whl"`,
			"",
		].join("\n"),
	);
	const gemCommand = join(directory, "gem");
	await writeFile(
		gemCommand,
		[
			"#!/bin/sh",
			'while [ "$#" -gt 0 ]; do',
			'  if [ "$1" = "--output" ]; then output_file="$2"; fi',
			"  shift",
			"done",
			'touch "$output_file"',
			"",
		].join("\n"),
	);
	await chmod(uvCommand, 0o755);
	await chmod(gemCommand, 0o755);
	return { uvCommand, gemCommand };
}

describe("assembleRelease", () => {
	test("verifies the binaries, then renders every package under the output directory", async () => {
		const binaries = await fakeBinaries();
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-assemble-out-")),
			"assembled",
		);
		// What a local mix run leaves behind must not ride along into the package.
		const root = await rootCopy();
		await mkdir(join(root, "packages/hex/_build/dev"), { recursive: true });
		await mkdir(join(root, "packages/hex/deps"), { recursive: true });
		await writeFile(
			join(root, "packages/hex/checksums.exs"),
			"%{stale: true}\n",
		);
		const written = await assembleRelease(binaries, out, {
			...(await fakeTools()),
			root,
		});
		expect(written).toEqual([
			join(out, "npm"),
			join(out, "wheels"),
			join(out, "hex"),
			join(out, "gems"),
			join(out, "homebrew/llm-tests-forge.rb"),
		]);
		expect((await readdir(join(out, "npm"))).sort()).toEqual(
			["main", ...RELEASE_TARGETS.map(platformDirectoryName)].sort(),
		);
		expect((await readdir(join(out, "wheels"))).sort()).toEqual(
			RELEASE_TARGETS.map((target) =>
				wheelFileName(FORGE_VERSION, target),
			).sort(),
		);
		expect((await readdir(join(out, "gems"))).sort()).toEqual(
			RELEASE_TARGETS.map((target) =>
				gemFileName(FORGE_VERSION, target),
			).sort(),
		);
		const sums = await readFile(join(binaries, CHECKSUMS_FILE_NAME), "utf8");
		const checksumsExs = await readFile(join(out, "hex/checksums.exs"), "utf8");
		for (const line of sums.trimEnd().split("\n")) {
			const [hash, name] = line.split("  ");
			expect(checksumsExs).toContain(`"${name}" => "${hash}"`);
		}
		expect(await readFile(join(out, "hex/mix.exs"), "utf8")).toContain(
			`version: "${FORGE_VERSION}"`,
		);
		expect((await readdir(join(out, "hex"))).sort()).toEqual(
			[
				".formatter.exs",
				"LICENSE",
				"checksums.exs",
				"checksums.exs.tmpl",
				"lib",
				"mix.exs",
				"test",
			].sort(),
		);
		expect(checksumsExs).not.toContain("stale");
		const license = await readFile(join(root, "LICENSE"), "utf8");
		expect(await readFile(join(out, "hex/LICENSE"), "utf8")).toBe(license);
		expect(await readFile(join(out, "npm/main/LICENSE"), "utf8")).toBe(license);
		expect(
			await readFile(join(root, "packages/hex/checksums.exs"), "utf8"),
		).toBe("%{stale: true}\n");
		const formula = await readFile(
			join(out, "homebrew/llm-tests-forge.rb"),
			"utf8",
		);
		expect(formula).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/download/v${FORGE_VERSION}/llm-tests-forge-darwin-arm64`,
		);
		expect(formula).not.toContain("{{");
	});

	test("makes every binary executable before the renderers copy it (an artifact download drops the bit)", async () => {
		const binaries = await fakeBinaries();
		const out = await mkdtemp(join(tmpdir(), "forge-assemble-out-"));
		await assembleRelease(binaries, out, { ...(await fakeTools()) });
		for (const target of RELEASE_TARGETS)
			expect((await stat(join(binaries, target.assetName))).mode & 0o777).toBe(
				0o755,
			);
	});

	test("refuses a binary whose bytes differ from SHA256SUMS, naming it, before rendering anything", async () => {
		const binaries = await fakeBinaries();
		const tampered = RELEASE_TARGETS[2]?.assetName ?? "";
		await writeFile(join(binaries, tampered), "other bytes\n");
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-assemble-out-")),
			"assembled",
		);
		const failure = assembleRelease(binaries, out, { ...(await fakeTools()) });
		await expect(failure).rejects.toThrow(ForgeError);
		await expect(failure).rejects.toThrow(`${tampered} (different)`);
		expect(await Bun.file(out).exists()).toBe(false);
		expect(await readdir(join(out, "..")).catch(() => [])).toEqual([]);
	});

	test("refuses a binary that SHA256SUMS lists but the directory lacks", async () => {
		const binaries = await fakeBinaries();
		const missing = RELEASE_TARGETS[0]?.assetName ?? "";
		await Bun.file(join(binaries, missing)).delete();
		const out = await mkdtemp(join(tmpdir(), "forge-assemble-out-"));
		await expect(
			assembleRelease(binaries, out, { ...(await fakeTools()) }),
		).rejects.toThrow(`${missing} (missing)`);
	});

	test("a prerelease version (0.1.0-rc.1, what a v0.1.0-rc.1 tag requires) goes through every renderer", async () => {
		const version = "0.1.0-rc.1";
		const root = await rootCopy(version);
		await stampVersion(root);
		const out = await mkdtemp(join(tmpdir(), "forge-assemble-out-"));
		await assembleRelease(await fakeBinaries(), out, {
			...(await fakeTools("0.1.0rc1")),
			root,
		});
		expect((await readdir(join(out, "wheels"))).sort()).toEqual(
			RELEASE_TARGETS.map(
				(target) => `llm_tests_forge-0.1.0rc1-py3-none-${target.wheelTag}.whl`,
			).sort(),
		);
		expect((await readdir(join(out, "gems"))).sort()).toEqual(
			RELEASE_TARGETS.map((target) => gemFileName(version, target)).sort(),
		);
		const mainManifest = JSON.parse(
			await readFile(join(out, "npm/main/package.json"), "utf8"),
		);
		expect(mainManifest.version).toBe(version);
		expect(Object.values(mainManifest.optionalDependencies)).toEqual(
			RELEASE_TARGETS.map(() => version),
		);
		for (const target of RELEASE_TARGETS)
			expect(
				JSON.parse(
					await readFile(
						join(out, "npm", platformDirectoryName(target), "package.json"),
						"utf8",
					),
				).version,
			).toBe(version);
		expect(await readFile(join(out, "hex/mix.exs"), "utf8")).toContain(
			`version: "${version}"`,
		);
		expect(await readFile(join(out, "hex/checksums.exs"), "utf8")).toContain(
			version,
		);
		const formula = await readFile(
			join(out, "homebrew/llm-tests-forge.rb"),
			"utf8",
		);
		expect(formula).toContain(`  version "${version}"\n`);
		expect(formula).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/download/v${version}/llm-tests-forge-darwin-arm64`,
		);
	});

	test("refuses a version the wheels cannot carry before writing any package", async () => {
		const root = await rootCopy("0.1.0-next.1");
		await stampVersion(root);
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-assemble-out-")),
			"assembled",
		);
		await expect(
			assembleRelease(await fakeBinaries(), out, {
				...(await fakeTools()),
				root,
			}),
		).rejects.toThrow("version 0.1.0-next.1 has a prerelease label");
		expect(await Bun.file(join(out, "npm/main/package.json")).exists()).toBe(
			false,
		);
	});

	test("refuses a release binary that neither the directory nor SHA256SUMS holds (four of five), naming it, before rendering anything", async () => {
		const binaries = await mkdtemp(join(tmpdir(), "forge-assemble-binaries-"));
		const [absent, ...present] = RELEASE_TARGETS;
		for (const target of present)
			await writeFile(
				join(binaries, target.assetName),
				`# ${target.assetName}\n`,
			);
		await writeChecksums(binaries);
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-assemble-out-")),
			"assembled",
		);
		const failure = assembleRelease(binaries, out, { ...(await fakeTools()) });
		await expect(failure).rejects.toThrow(ForgeError);
		await expect(failure).rejects.toThrow(
			`release binary is missing (file: ${join(binaries, absent?.assetName ?? "")})`,
		);
		expect(await Bun.file(join(out, "npm/main/package.json")).exists()).toBe(
			false,
		);
	});

	test("refuses when a manifest is not stamped with package.json's version, naming it", async () => {
		const root = await rootCopy("9.9.9");
		const out = await mkdtemp(join(tmpdir(), "forge-assemble-out-"));
		await expect(
			assembleRelease(await fakeBinaries(), out, {
				...(await fakeTools()),
				root,
			}),
		).rejects.toThrow(
			"not stamped with 9.9.9 (run release:stamp): plugin/.claude-plugin/plugin.json has",
		);
	});
});

describe("runAssemble", () => {
	test("prints each path written and returns 0", async () => {
		const printed: string[] = [];
		const out = await mkdtemp(join(tmpdir(), "forge-assemble-out-"));
		const code = await runAssemble(
			[await fakeBinaries(), out],
			(line) => printed.push(line),
			{ ...(await fakeTools()) },
		);
		expect(code).toBe(0);
		expect(printed).toHaveLength(5);
		expect(printed[0]).toBe(join(resolve(out), "npm"));
	});

	test("refuses a command line without both directories", async () => {
		await expect(runAssemble(["only-one"], () => {})).rejects.toThrow(
			new UsageError("usage: assemble.ts <binaries-directory> <out-directory>"),
		);
		await expect(runAssemble(["a", "b", "c"], () => {})).rejects.toThrow(
			UsageError,
		);
	});
});
