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
import {
	fallbackGemFileName,
	gemFileName,
	renderFallbackGem,
	renderGems,
	runGems,
} from "../../scripts/release/gems";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
	checkVersions,
	GEM_MANIFESTS,
	MANIFESTS,
} from "../../scripts/release/version";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const REPOSITORY = resolve(import.meta.dir, "../..");
const FIRST_TARGET = RELEASE_TARGETS[0];
if (FIRST_TARGET === undefined) throw new Error("no release targets");

/** A repository root holding a copy of the committed gem package and a package.json at `version`. */
async function rootWithGemPackage(version = FORGE_VERSION): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-gems-root-"));
	await mkdir(join(root, "packages"), { recursive: true });
	await cp(join(REPOSITORY, "packages/gem"), join(root, "packages/gem"), {
		recursive: true,
	});
	await writeFile(join(root, "package.json"), `{ "version": "${version}" }\n`);
	await cp(join(REPOSITORY, "LICENSE"), join(root, "LICENSE"));
	return root;
}

async function fakeBinaries(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-gems-binaries-"));
	for (const target of RELEASE_TARGETS)
		await writeFile(
			join(directory, target.assetName),
			`# ${target.assetName}\n`,
		);
	return directory;
}

/**
 * A stand-in for the `gem` command that records the two variables it was
 * given and the directory it ran in (one line per call, in `calls`) and
 * writes the gem a real `gem build <gemspec> --output <file>` would, unless
 * told to fail or to write nothing.
 */
async function fakeGemTool(
	behavior: "writes-gem" | "fails" | "writes-nothing" = "writes-gem",
): Promise<{ directory: string; command: string; calls: string }> {
	const directory = await mkdtemp(join(tmpdir(), "forge-fake-gem-"));
	const command = join(directory, "gem");
	const calls = join(directory, "calls.log");
	const script = [
		"#!/bin/sh",
		`echo "$FORGE_GEM_PLATFORM|$FORGE_GEM_BINARY|$(pwd)|$*|$(cmp -s LICENSE "${join(REPOSITORY, "LICENSE")}" && echo the-repository-license)" >> "${calls}"`,
		behavior === "fails" ? 'echo "cannot build" >&2; exit 3' : "",
		'output_file=""',
		'while [ "$#" -gt 0 ]; do',
		'  if [ "$1" = "--output" ]; then output_file="$2"; fi',
		"  shift",
		"done",
		behavior === "writes-gem" ? 'touch "$output_file"' : "",
		"exit 0",
		"",
	].join("\n");
	await writeFile(command, script);
	await chmod(command, 0o755);
	return { directory, command, calls };
}

describe("the gem manifest", () => {
	test("the gemspec is in the stamped list with a text pattern", () => {
		const registered = MANIFESTS.filter((manifest) =>
			manifest.path.startsWith("packages/gem/"),
		);
		expect(registered).toEqual([...GEM_MANIFESTS]);
		expect(registered.map((manifest) => manifest.path)).toEqual([
			"packages/gem/llm-tests-forge.gemspec",
		]);
		expect(registered[0]?.format).toBe("text");
	});

	test("a gemspec left at another version is named by the check, and only the line-anchored version counts", async () => {
		const root = await rootWithGemPackage();
		const path = join(root, "packages/gem/llm-tests-forge.gemspec");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			`# specification.version = "1.2.3"\n${text.replace(`specification.version = "${FORGE_VERSION}"`, 'specification.version = "0.0.9"')}`,
		);
		expect(await checkVersions(root, GEM_MANIFESTS)).toEqual([
			{ path: "packages/gem/llm-tests-forge.gemspec", found: "0.0.9" },
		]);
	});
});

describe("the gem package directory", () => {
	test("the binaries a gemspec run copies under exe/<platform>/ are ignored by the repository, and the shim is not", () => {
		const ignored = (path: string) =>
			Bun.spawnSync(["git", "check-ignore", "--quiet", "--no-index", path], {
				cwd: REPOSITORY,
			}).exitCode;
		for (const target of RELEASE_TARGETS)
			expect({
				target: target.gemPlatform,
				exitCode: ignored(
					`packages/gem/exe/${target.gemPlatform}/llm-tests-forge`,
				),
			}).toEqual({ target: target.gemPlatform, exitCode: 0 });
		expect(ignored("packages/gem/exe/llm-tests-forge")).toBe(1);
	}, 30_000);
});

describe("gems", () => {
	test("one gem build per target with that target's platform and binary in the variables, gems returned in target order", async () => {
		const tool = await fakeGemTool();
		const binaries = await fakeBinaries();
		const out = join(await mkdtemp(join(tmpdir(), "forge-gems-out-")), "gems");
		const written = await renderGems(binaries, out, REPOSITORY, tool.command);
		expect(written).toEqual(
			RELEASE_TARGETS.map((target) =>
				join(out, gemFileName(FORGE_VERSION, target)),
			),
		);
		const lines = (await readFile(tool.calls, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(RELEASE_TARGETS.length);
		RELEASE_TARGETS.forEach((target, index) => {
			const [platform, binary, directory, command, license] = (
				lines[index] ?? ""
			).split("|");
			expect(license).toBe("the-repository-license");
			expect(platform).toBe(target.gemPlatform);
			expect(binary).toBe(join(binaries, target.assetName));
			expect(directory).not.toContain(REPOSITORY);
			expect(command).toBe(
				`build llm-tests-forge.gemspec --output ${join(out, gemFileName(FORGE_VERSION, target))}`,
			);
		});
	}, 30_000);

	test("a repository without its LICENSE is refused naming it, before any build runs", async () => {
		const root = await rootWithGemPackage();
		await rm(join(root, "LICENSE"));
		const tool = await fakeGemTool();
		await expect(
			renderGems(await fakeBinaries(), join(root, "out"), root, tool.command),
		).rejects.toThrow(
			`the LICENSE every package ships is missing (file: ${join(root, "LICENSE")})`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("the gem file name carries the version and the platform", () => {
		expect(gemFileName("1.2.3", FIRST_TARGET)).toBe(
			"llm-tests-forge-1.2.3-arm64-darwin.gem",
		);
	});

	test("a gemspec left at another version refuses the build, naming it and the stamp command", async () => {
		const root = await rootWithGemPackage("9.9.9");
		const tool = await fakeGemTool();
		await expect(
			renderGems(await fakeBinaries(), join(root, "out"), root, tool.command),
		).rejects.toThrow(
			`not stamped with 9.9.9 (run release:stamp): packages/gem/llm-tests-forge.gemspec has ${FORGE_VERSION}`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a missing release binary is refused naming its path, before any build runs", async () => {
		const tool = await fakeGemTool();
		const binaries = await mkdtemp(join(tmpdir(), "forge-gems-binaries-"));
		await expect(
			renderGems(binaries, join(binaries, "out"), REPOSITORY, tool.command),
		).rejects.toThrow(
			`release binary is missing (file: ${join(binaries, FIRST_TARGET.assetName)})`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a failing gem build is refused with its exit code, the platform and what gem said", async () => {
		const tool = await fakeGemTool("fails");
		const binaries = await fakeBinaries();
		await expect(
			renderGems(binaries, join(binaries, "out"), REPOSITORY, tool.command),
		).rejects.toThrow(
			"gem build failed for arm64-darwin (exit 3): cannot build",
		);
	}, 30_000);

	test("a gem build that exits 0 without writing the gem is refused naming the gem", async () => {
		const tool = await fakeGemTool("writes-nothing");
		const binaries = await fakeBinaries();
		const out = join(binaries, "out");
		await expect(
			renderGems(binaries, out, REPOSITORY, tool.command),
		).rejects.toThrow(
			`gem build did not write the gem (file: ${join(out, gemFileName(FORGE_VERSION, FIRST_TARGET))})`,
		);
	}, 30_000);

	test("the command prints each gem it wrote (gem found on the PATH), and anything but two arguments is a usage error", async () => {
		const tool = await fakeGemTool();
		const binaries = await fakeBinaries();
		const out = join(binaries, "out");
		const previousPath = process.env.PATH;
		process.env.PATH = `${tool.directory}:${previousPath ?? ""}`;
		const printed: string[] = [];
		try {
			expect(await runGems([binaries, out], (line) => printed.push(line))).toBe(
				0,
			);
		} finally {
			process.env.PATH = previousPath;
		}
		expect(printed).toEqual(
			RELEASE_TARGETS.map((target) =>
				join(out, gemFileName(FORGE_VERSION, target)),
			),
		);
		for (const argumentsList of [[], ["binaries"], ["a", "b", "c"]])
			await expect(runGems(argumentsList, () => {})).rejects.toBeInstanceOf(
				UsageError,
			);
	}, 30_000);
});

describe("the fallback gem", () => {
	test("one gem build on a scratch copy holding the LICENSE, with the platform ruby and no binary variable, even when the caller's environment sets one", async () => {
		const tool = await fakeGemTool();
		const out = join(
			await mkdtemp(join(tmpdir(), "forge-gems-out-")),
			"fallbacks",
		);
		const previousBinary = process.env.FORGE_GEM_BINARY;
		process.env.FORGE_GEM_BINARY = "/a/binary/the/caller/left/set";
		let written: string;
		try {
			written = await renderFallbackGem(out, REPOSITORY, tool.command);
		} finally {
			if (previousBinary === undefined) delete process.env.FORGE_GEM_BINARY;
			else process.env.FORGE_GEM_BINARY = previousBinary;
		}
		expect(written).toBe(join(out, fallbackGemFileName(FORGE_VERSION)));
		expect(await Bun.file(written).exists()).toBe(true);
		const lines = (await readFile(tool.calls, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		const [platform, binary, directory, command, license] = (
			lines[0] ?? ""
		).split("|");
		expect({ platform, binary, command, license }).toEqual({
			platform: "ruby",
			binary: "",
			command: `build llm-tests-forge.gemspec --output ${written}`,
			license: "the-repository-license",
		});
		expect(directory).not.toContain(REPOSITORY);
	}, 30_000);

	test("the fallback gem's file name carries the version and no platform, as RubyGems names a ruby-platform gem", () => {
		expect(fallbackGemFileName("1.2.3")).toBe("llm-tests-forge-1.2.3.gem");
	});

	test("a gemspec left at another version refuses the fallback build too, before gem runs", async () => {
		const root = await rootWithGemPackage("9.9.9");
		const tool = await fakeGemTool();
		await expect(
			renderFallbackGem(join(root, "out"), root, tool.command),
		).rejects.toThrow(
			`not stamped with 9.9.9 (run release:stamp): packages/gem/llm-tests-forge.gemspec has ${FORGE_VERSION}`,
		);
		expect(await Bun.file(tool.calls).exists()).toBe(false);
	});

	test("a failing gem build of the fallback is refused naming the platform ruby and what gem said", async () => {
		const tool = await fakeGemTool("fails");
		const out = await mkdtemp(join(tmpdir(), "forge-gems-out-"));
		await expect(
			renderFallbackGem(out, REPOSITORY, tool.command),
		).rejects.toThrow("gem build failed for ruby (exit 3): cannot build");
	}, 30_000);
});
