import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkVersions,
	MANIFESTS,
	type Manifest,
	releaseVersion,
	runVersion,
	stampVersion,
} from "../../scripts/release/version";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const JSON_MANIFEST: Manifest = {
	path: "plugin.json",
	format: "json",
	pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
};
const TEXT_MANIFEST: Manifest = {
	path: "mix.exs",
	format: "text",
	pattern: /^(\s*@version ")([^"]*)(")/m,
};

async function treeWith(
	files: Record<string, string>,
	version = "1.2.3",
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-version-"));
	await writeFile(
		join(root, "package.json"),
		`{\n\t"name": "x",\n\t"version": "${version}"\n}\n`,
	);
	for (const [name, content] of Object.entries(files))
		await writeFile(join(root, name), content);
	return root;
}

describe("the committed tree", () => {
	test("every package manifest exists and carries package.json's version", async () => {
		expect(await releaseVersion()).toBe(FORGE_VERSION);
		expect(MANIFESTS.length).toBeGreaterThan(0);
		for (const manifest of MANIFESTS)
			expect(
				(await stat(join(import.meta.dir, "../..", manifest.path))).isFile(),
			).toBe(true);
		expect(await checkVersions()).toEqual([]);
	});
});

describe("version stamping", () => {
	const manifests = [JSON_MANIFEST, TEXT_MANIFEST];

	test("stamp writes package.json's version into a JSON and a text manifest, touching nothing else, and a second run changes nothing", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "name": "p",\n "version": "0.0.1"\n}\n',
			"mix.exs": '  @version "0.0.1"\n  @other "9.9.9"\n',
		});
		expect(await stampVersion(root, manifests)).toEqual([
			"plugin.json",
			"mix.exs",
		]);
		expect(await readFile(join(root, "plugin.json"), "utf8")).toBe(
			'{\n "name": "p",\n "version": "1.2.3"\n}\n',
		);
		expect(await readFile(join(root, "mix.exs"), "utf8")).toBe(
			'  @version "1.2.3"\n  @other "9.9.9"\n',
		);
		expect(await stampVersion(root, manifests)).toEqual([]);
	});

	test("check names every manifest that disagrees, with what it found", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "version": "0.0.1"\n}\n',
			"mix.exs": '  @version "1.2.3"\n',
		});
		expect(await checkVersions(root, manifests)).toEqual([
			{ path: "plugin.json", found: "0.0.1" },
		]);
	});

	test("a manifest with no version, or unparseable JSON, disagrees with found undefined", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "name": "p"\n}\n',
			"mix.exs": "defmodule X do\nend\n",
		});
		expect(await checkVersions(root, manifests)).toEqual([
			{ path: "plugin.json", found: undefined },
			{ path: "mix.exs", found: undefined },
		]);
		await writeFile(join(root, "plugin.json"), "{ not json");
		await writeFile(join(root, "mix.exs"), '  @version "1.2.3"\n');
		expect(await checkVersions(root, manifests)).toEqual([
			{ path: "plugin.json", found: undefined },
		]);
		await writeFile(join(root, "plugin.json"), '"just a string"');
		expect(await checkVersions(root, manifests)).toEqual([
			{ path: "plugin.json", found: undefined },
		]);
		await writeFile(join(root, "plugin.json"), '{"version": 3}');
		expect(await checkVersions(root, manifests)).toEqual([
			{ path: "plugin.json", found: undefined },
		]);
	});

	test("stamp refuses a manifest with nothing to stamp, naming it, and a JSON whose only version key is nested", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "name": "p"\n}\n',
			"mix.exs": '  @version "0.0.1"\n',
		});
		await expect(stampVersion(root, [JSON_MANIFEST])).rejects.toThrow(
			`no version to stamp (expected 1.2.3) (file: ${join(root, "plugin.json")})`,
		);
		await writeFile(
			join(root, "plugin.json"),
			'{\n "dependencies": {\n  "a": {\n   "x": 1\n  }\n },\n "meta": {\n  "version": "0.0.1"\n }\n}\n',
		);
		await expect(stampVersion(root, [JSON_MANIFEST])).rejects.toThrow(
			`no version to stamp (expected 1.2.3) (file: ${join(root, "plugin.json")})`,
		);
	});

	test("a missing manifest is an error naming its path, for stamp and for check", async () => {
		const root = await treeWith({});
		const expected = `manifest cannot be read (file: ${join(root, "plugin.json")})`;
		await expect(stampVersion(root, [JSON_MANIFEST])).rejects.toThrow(expected);
		await expect(checkVersions(root, [JSON_MANIFEST])).rejects.toThrow(
			expected,
		);
	});

	test("a package.json without a version is refused", async () => {
		const root = await treeWith({});
		await writeFile(join(root, "package.json"), '{ "name": "x" }');
		await expect(releaseVersion(root)).rejects.toThrow(
			`package.json has no version (file: ${join(root, "package.json")})`,
		);
	});
});

describe("version command", () => {
	const manifests = [JSON_MANIFEST];

	test("check exits 0 silently when every manifest agrees", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "version": "1.2.3"\n}\n',
		});
		const printed: string[] = [];
		expect(
			await runVersion(
				["check"],
				(line) => printed.push(line),
				root,
				manifests,
			),
		).toBe(0);
		expect(printed).toEqual([]);
	});

	test("check exits 1 listing each manifest that disagrees, with both versions", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "version": "0.0.1"\n}\n',
			"mix.exs": "nothing",
		});
		const printed: string[] = [];
		expect(
			await runVersion(["check"], (line) => printed.push(line), root, [
				JSON_MANIFEST,
				TEXT_MANIFEST,
			]),
		).toBe(1);
		expect(printed).toEqual([
			"plugin.json: 0.0.1 (package.json: 1.2.3)",
			"mix.exs: no version (package.json: 1.2.3)",
		]);
	});

	test("stamp reports how many manifests it changed and then check passes", async () => {
		const root = await treeWith({
			"plugin.json": '{\n "version": "0.0.1"\n}\n',
		});
		const printed: string[] = [];
		expect(
			await runVersion(
				["stamp"],
				(line) => printed.push(line),
				root,
				manifests,
			),
		).toBe(0);
		expect(printed).toEqual(["stamped 1.2.3 into 1 of 1 manifests"]);
		expect(await runVersion(["check"], () => {}, root, manifests)).toBe(0);
	});

	test("stamp counts distinct files: two entries on one file are one manifest, listed once", async () => {
		const root = await treeWith({
			"mix.exs": '  @version "0.0.1"\n  @dependency_version "0.0.1"\n',
		});
		const twoEntries: Manifest[] = [
			TEXT_MANIFEST,
			{
				path: "mix.exs",
				format: "text",
				pattern: /^(\s*@dependency_version ")([^"]*)(")/m,
			},
		];
		expect(await stampVersion(root, twoEntries)).toEqual(["mix.exs"]);
		await writeFile(
			join(root, "mix.exs"),
			'  @version "0.0.1"\n  @dependency_version "0.0.1"\n',
		);
		const printed: string[] = [];
		await runVersion(["stamp"], (line) => printed.push(line), root, twoEntries);
		expect(printed).toEqual(["stamped 1.2.3 into 1 of 1 manifests"]);
	});

	test("anything but exactly stamp or check is a usage error", async () => {
		for (const argumentsList of [[], ["bump"], ["check", "extra"]])
			await expect(runVersion(argumentsList, () => {})).rejects.toBeInstanceOf(
				UsageError,
			);
	});
});
