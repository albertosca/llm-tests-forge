import { describe, expect, test } from "bun:test";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
	checkVersions,
	MANIFESTS,
	PYPI_MANIFESTS,
	stampVersion,
} from "../../scripts/release/version";
import {
	pep440Version,
	renderWheels,
	runWheels,
	wheelFileName,
} from "../../scripts/release/wheels";
import { ForgeError, UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");
const FIRST_TARGET = RELEASE_TARGETS[0];
if (FIRST_TARGET === undefined) throw new Error("no release targets");

/** A repository root holding a copy of the committed wheel package and a package.json at `version`. */
async function rootWithWheelPackage(version = FORGE_VERSION): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-wheels-root-"));
	await mkdir(join(root, "packages"), { recursive: true });
	await cp(join(REPOSITORY, "packages/pypi"), join(root, "packages/pypi"), {
		recursive: true,
	});
	await writeFile(join(root, "package.json"), `{ "version": "${version}" }\n`);
	await cp(join(REPOSITORY, "LICENSE"), join(root, "LICENSE"));
	return root;
}

async function fakeBinaries(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-wheels-binaries-"));
	for (const target of RELEASE_TARGETS)
		await writeFile(
			join(directory, target.assetName),
			`# ${target.assetName}\n`,
		);
	return directory;
}

/**
 * A stand-in for the `uv` command that records the two variables it was
 * given (one line per call, in `calls`) and writes the wheel a real `uv
 * build --wheel --out-dir <dir>` would, unless told to fail or to write
 * nothing.
 */
async function fakeUvTool(
	behavior: "writes-wheel" | "fails" | "writes-nothing" = "writes-wheel",
): Promise<{ directory: string; command: string; calls: string }> {
	const directory = await mkdtemp(join(tmpdir(), "forge-fake-uv-"));
	const command = join(directory, "uv");
	const calls = join(directory, "calls.log");
	const script = [
		"#!/bin/sh",
		`echo "$FORGE_WHEEL_PLATFORM|$FORGE_WHEEL_BINARY|$*" >> "${calls}"`,
		behavior === "fails" ? 'echo "no index reachable" >&2; exit 3' : "",
		'out_directory=""',
		'while [ "$#" -gt 0 ]; do',
		'  if [ "$1" = "--out-dir" ]; then out_directory="$2"; fi',
		"  shift",
		"done",
		behavior === "writes-wheel"
			? `touch "$out_directory/llm_tests_forge-${pep440Version(FORGE_VERSION)}-py3-none-$FORGE_WHEEL_PLATFORM.whl"`
			: "",
		"exit 0",
		"",
	].join("\n");
	await writeFile(command, script);
	await chmod(command, 0o755);
	return { directory, command, calls };
}

describe("the pypi manifest", () => {
	test("pyproject.toml is in the stamped list with a text pattern", () => {
		const registered = MANIFESTS.filter((manifest) =>
			manifest.path.startsWith("packages/pypi/"),
		);
		expect(registered).toEqual([...PYPI_MANIFESTS]);
		expect(registered.map((manifest) => manifest.path)).toEqual([
			"packages/pypi/pyproject.toml",
		]);
		expect(registered[0]?.format).toBe("text");
	});

	test("a pyproject.toml left at another version is named by the check, and only the line-anchored version counts", async () => {
		const root = await rootWithWheelPackage();
		const path = join(root, "packages/pypi/pyproject.toml");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			`# requires-python version = "1.2.3"\n${text.replace(`\nversion = "${FORGE_VERSION}"`, '\nversion = "0.0.9"')}`,
		);
		expect(await checkVersions(root, PYPI_MANIFESTS)).toEqual([
			{ path: "packages/pypi/pyproject.toml", found: "0.0.9" },
		]);
	});
});

describe("pep440Version", () => {
	test("a release version is unchanged, and each semver prerelease takes the PEP 440 spelling", () => {
		expect(pep440Version("0.1.0")).toBe("0.1.0");
		expect(pep440Version("12.30.4")).toBe("12.30.4");
		expect(pep440Version("0.1.0-rc.1")).toBe("0.1.0rc1");
		expect(pep440Version("0.1.0-rc1")).toBe("0.1.0rc1");
		expect(pep440Version("0.2.0-alpha.3")).toBe("0.2.0a3");
		expect(pep440Version("0.2.0-beta.12")).toBe("0.2.0b12");
	});

	test("a prerelease label PEP 440 cannot express is refused, naming the version and the label", () => {
		for (const [version, label] of [
			["0.1.0-next.1", "next.1"],
			["0.1.0-rc", "rc"],
			["0.1.0-rc.1.2", "rc.1.2"],
			["0.1.0+build.5", "+build.5"],
			// Build metadata may have leading zeros (SemVer allows them there);
			// it is refused for what it is, not as a leading zero.
			["1.0.0+001", "+001"],
			["1.0.0-rc.1+007", "rc.1+007"],
		] as const)
			expect(() => pep440Version(version)).toThrow(
				new ForgeError(
					`version ${version} has a prerelease label PEP 440 cannot express (${label}); use -alpha.N, -beta.N or -rc.N`,
				),
			);
	});

	test("a number with a leading zero is refused, naming the version: SemVer forbids it and uv would write it without the zero", () => {
		for (const [version, number] of [
			["0.1.0-rc.01", "01"],
			["0.1.0-rc01", "01"],
			["0.2.0-beta.007", "007"],
			["01.2.3", "01"],
			["1.02.3", "02"],
			["1.2.00", "00"],
		] as const)
			expect(() => pep440Version(version)).toThrow(
				new ForgeError(
					`version ${version} has a number with a leading zero (${number}), which SemVer forbids and the wheel would spell without it`,
				),
			);
		expect(pep440Version("0.1.0-rc.0")).toBe("0.1.0rc0");
		expect(pep440Version("10.20.30-rc.10")).toBe("10.20.30rc10");
	});

	test("a version that is not MAJOR.MINOR.PATCH is refused, naming it", () => {
		expect(() => pep440Version("1.2")).toThrow(
			new ForgeError("version 1.2 is not MAJOR.MINOR.PATCH"),
		);
	});
});

describe("wheels", () => {
	test("one uv build per target with that target's tag and binary in the variables, wheels returned in target order", async () => {
		const tool = await fakeUvTool();
		const binaries = await fakeBinaries();
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-wheels-out-")),
			"wheels",
		);
		const written = await renderWheels(binaries, out, REPOSITORY, tool.command);
		expect(written).toEqual(
			RELEASE_TARGETS.map((target) =>
				join(out, wheelFileName(FORGE_VERSION, target)),
			),
		);
		const lines = (await readFile(tool.calls, "utf8")).trim().split("\n");
		expect(lines).toEqual(
			RELEASE_TARGETS.map(
				(target) =>
					`${target.wheelTag}|${join(binaries, target.assetName)}|build --wheel --out-dir ${out} ${join(REPOSITORY, "packages/pypi")}`,
			),
		);
	}, 30_000);

	test("the wheel file name carries the version and the tag", () => {
		expect(wheelFileName("1.2.3", FIRST_TARGET)).toBe(
			"llm_tests_forge-1.2.3-py3-none-macosx_11_0_arm64.whl",
		);
	});

	test("the wheel file name of a prerelease carries the PEP 440 spelling uv writes", () => {
		expect(wheelFileName("0.1.0-rc.1", FIRST_TARGET)).toBe(
			"llm_tests_forge-0.1.0rc1-py3-none-macosx_11_0_arm64.whl",
		);
	});

	test("a pyproject.toml left at another version refuses the build, naming it and the stamp command", async () => {
		const root = await rootWithWheelPackage("9.9.9");
		const tool = await fakeUvTool();
		await expect(
			renderWheels(await fakeBinaries(), join(root, "out"), root, tool.command),
		).rejects.toThrow(
			`not stamped with 9.9.9 (run release:stamp): packages/pypi/pyproject.toml has ${FORGE_VERSION}`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a version whose prerelease label PEP 440 cannot express is refused before any build runs", async () => {
		const root = await rootWithWheelPackage("0.1.0-next.1");
		await stampVersion(root, PYPI_MANIFESTS);
		const tool = await fakeUvTool();
		await expect(
			renderWheels(await fakeBinaries(), join(root, "out"), root, tool.command),
		).rejects.toThrow("version 0.1.0-next.1 has a prerelease label");
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a repository without its LICENSE is refused naming it, before any build runs", async () => {
		const root = await rootWithWheelPackage();
		await rm(join(root, "LICENSE"));
		const tool = await fakeUvTool();
		await expect(
			renderWheels(await fakeBinaries(), join(root, "out"), root, tool.command),
		).rejects.toThrow(
			`the LICENSE every package ships is missing (file: ${join(root, "LICENSE")})`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a missing release binary is refused naming its path, before any build runs", async () => {
		const tool = await fakeUvTool();
		const binaries = await mkdtemp(join(tmpdir(), "forge-wheels-binaries-"));
		await expect(
			renderWheels(binaries, join(binaries, "out"), REPOSITORY, tool.command),
		).rejects.toThrow(
			`release binary is missing (file: ${join(binaries, FIRST_TARGET.assetName)})`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a failing uv build is refused with its exit code, the platform tag and what uv said", async () => {
		const tool = await fakeUvTool("fails");
		const binaries = await fakeBinaries();
		await expect(
			renderWheels(binaries, join(binaries, "out"), REPOSITORY, tool.command),
		).rejects.toThrow(
			"uv build failed for macosx_11_0_arm64 (exit 3): no index reachable",
		);
	}, 30_000);

	test("a uv build that exits 0 without writing the wheel is refused naming the wheel", async () => {
		const tool = await fakeUvTool("writes-nothing");
		const binaries = await fakeBinaries();
		const out = join(binaries, "out");
		await expect(
			renderWheels(binaries, out, REPOSITORY, tool.command),
		).rejects.toThrow(
			`uv build did not write the wheel (file: ${join(out, wheelFileName(FORGE_VERSION, FIRST_TARGET))})`,
		);
	}, 30_000);

	test("the command prints each wheel it wrote (uv found on the PATH), and anything but two arguments is a usage error", async () => {
		const tool = await fakeUvTool();
		const binaries = await fakeBinaries();
		const out = join(binaries, "out");
		const previousPath = process.env.PATH;
		process.env.PATH = `${tool.directory}:${previousPath ?? ""}`;
		const printed: string[] = [];
		try {
			expect(
				await runWheels([binaries, out], (line) => printed.push(line)),
			).toBe(0);
		} finally {
			process.env.PATH = previousPath;
		}
		expect(printed).toEqual(
			RELEASE_TARGETS.map((target) =>
				join(out, wheelFileName(FORGE_VERSION, target)),
			),
		);
		for (const argumentsList of [[], ["binaries"], ["a", "b", "c"]])
			await expect(runWheels(argumentsList, () => {})).rejects.toBeInstanceOf(
				UsageError,
			);
	}, 30_000);
});
