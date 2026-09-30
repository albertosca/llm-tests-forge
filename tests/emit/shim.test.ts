import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feature } from "../../src/core/schemas";
import type { ShimKind } from "../../src/core/target";
import {
	findManifestDirectory,
	type ShimLocations,
	shimFiles,
	shimLocations,
	targetCommand,
} from "../../src/emit/shim";

const feature: Feature = {
	id: "classify-email",
	purpose: "p",
	inputs: [
		{ name: "email", kind: "text" },
		{ name: "stage", kind: "text" },
	],
	output: { kind: "label", labels: ["a"] },
	invariants: [],
	status: "approved",
};

const locations = (manifestText: string | null = null): ShimLocations => ({
	forgeDirectory: "/project/evals/a/.forge",
	manifestDirectory: manifestText === null ? null : "/project",
	manifestText,
});

function onlyContent(kind: ShimKind, entry: string): string {
	const [file] = shimFiles(feature, kind, entry, locations());
	return file?.content ?? "";
}

describe("shimFiles", () => {
	test("every kind fills the feature id and the input names, and leaves no placeholder", () => {
		const cases: Array<[ShimKind, string, string | null]> = [
			["python", "forge_target.py", null],
			["javascript", "forge_target.mjs", null],
			["typescript", "forge_target.ts", null],
			["elixir", "forge_target.exs", "defmodule App.MixProject do"],
			["ruby", "forge_target.rb", null],
			["rust", "forge_target", '[package]\nname = "my_app"\n'],
			["go", "forge_target", "module example.com/my-app\n\ngo 1.22\n"],
		];
		for (const [kind, entry, manifest] of cases) {
			const files = shimFiles(feature, kind, entry, locations(manifest));
			const all = files.map((file) => file.content).join("\n");
			expect(all).toContain("classify-email");
			expect(all).toContain('"email"');
			expect(all).toContain('"stage"');
			expect(all).not.toContain("{{");
			expect(all).toContain("llm-tests-forge emit");
			// Measured against promptfoo 0.123: a failure is an error row.
			expect(all).toContain("error row");
		}
	});
	test("the python shim keeps the call_api signature promptfoo expects, and returns the usage slot", () => {
		const files = shimFiles(feature, "python", "forge_target.py", locations());
		expect(files.map((file) => file.path)).toEqual(["forge_target.py"]);
		const source = files[0]?.content ?? "";
		expect(source).toContain("async def call_api(prompt, options, context):");
		expect(source).toContain('INPUTS = ["email", "stage"]');
		expect(source).toContain("# Feature: classify-email");
		expect(source).toContain(
			'model = (options.get("config") or {}).get("model")',
		);
		expect(source).toContain('"tokenUsage"');
	});
	test("each single-file kind writes its entry, with the inputs in the language's own syntax", () => {
		expect(onlyContent("javascript", "forge_target.mjs")).toContain(
			'const INPUTS = ["email", "stage"];',
		);
		expect(onlyContent("javascript", "forge_target.mjs")).toContain(
			"async callApi(prompt, context)",
		);
		expect(onlyContent("typescript", "forge_target.ts")).toContain(
			"interface RunResult",
		);
		expect(onlyContent("elixir", "forge_target.exs")).toContain(
			'@inputs ["email", "stage"]',
		);
		expect(onlyContent("ruby", "my_target.rb")).toContain(
			'INPUTS = ["email", "stage"].freeze',
		);
		expect(
			shimFiles(feature, "ruby", "my_target.rb", locations()).map(
				(file) => file.path,
			),
		).toEqual(["my_target.rb"]);
	});
	test("rust writes a crate of its own workspace and names the project's crate; go writes a module that points at the project's", () => {
		const rustFiles = shimFiles(
			feature,
			"rust",
			"forge_target",
			locations('[package]\nname = "my_app"\n'),
		);
		expect(rustFiles.map((file) => file.path)).toEqual([
			"forge_target/Cargo.toml",
			"forge_target/src/main.rs",
		]);
		expect(rustFiles[0]?.content).toContain("[workspace]");
		expect(rustFiles[0]?.content).toContain(
			'# my_app = { path = "../../../.." }',
		);
		expect(rustFiles[1]?.content).toContain(
			'const INPUTS: &[&str] = &["email", "stage"];',
		);
		const goFiles = shimFiles(
			feature,
			"go",
			"forge_target",
			locations("module example.com/my-app\n"),
		);
		expect(goFiles.map((file) => file.path)).toEqual([
			"forge_target/go.mod",
			"forge_target/main.go",
		]);
		expect(goFiles[0]?.content).toContain(
			"// replace example.com/my-app => ../../../..",
		);
		expect(goFiles[0]?.content).toContain(
			"// require example.com/my-app v0.0.0",
		);
		expect(goFiles[1]?.content).toContain(
			'var inputNames = []string{"email", "stage"}',
		);
	});
	test("the crate name is read under [package] only, and a quoted go module loses its quotes", () => {
		const rustFiles = shimFiles(
			feature,
			"rust",
			"forge_target",
			locations(
				'[workspace]\nname = "not_this"\n\n[package]\nversion = "1.0.0"\nname = "my_app"\n',
			),
		);
		expect(rustFiles[0]?.content).toContain(
			'# my_app = { path = "../../../.." }',
		);
		const goFiles = shimFiles(
			feature,
			"go",
			"forge_target",
			locations('// header\nmodule "example.com/quoted"\n'),
		);
		expect(goFiles[0]?.content).toContain(
			"// replace example.com/quoted => ../../../..",
		);
	});
	test("the crate name is read from a single-quoted name and from a [package] header followed by a comment", () => {
		const nameOf = (manifest: string): string | undefined =>
			shimFiles(feature, "rust", "forge_target", locations(manifest))[0]
				?.content;
		expect(nameOf("[package]\nname = 'my_app'\n")).toContain(
			'# my_app = { path = "../../../.." }',
		);
		expect(nameOf('[package] # app\nname = "my_app"\n')).toContain(
			'# my_app = { path = "../../../.." }',
		);
		expect(nameOf("[package]\t# app\nname = 'my_app'\n")).toContain(
			'# my_app = { path = "../../../.." }',
		);
		expect(nameOf('[workspace] # not it\nname = "not_this"\n')).toContain(
			"your_crate",
		);
	});
	test("with no manifest, rust and go write placeholders the comment says to fix", () => {
		const rustFiles = shimFiles(feature, "rust", "forge_target", locations());
		expect(rustFiles[0]?.content).toContain(
			'# your_crate = { path = "path/to/your/crate" }',
		);
		const goFiles = shimFiles(feature, "go", "forge_target", locations());
		expect(goFiles[0]?.content).toContain(
			"// replace example.com/your/module => path/to/your/module",
		);
	});
	test("the crate is read from every TOML spelling of [package]; a workspace or unreadable manifest names placeholders", () => {
		const dependencyLine = (manifest: string): string | undefined =>
			shimFiles(feature, "rust", "forge_target", locations(manifest))[0]
				?.content.split("\n")
				.find((line) => line.includes("{ path = "));
		const found = (name: string) => `# ${name} = { path = "../../../.." }`;
		const unknown = '# your_crate = { path = "path/to/your/crate" }';
		expect(dependencyLine('[ package ]\nname = "spaced"\n')).toBe(
			found("spaced"),
		);
		expect(dependencyLine('["package"]\nname = "quoted"\n')).toBe(
			found("quoted"),
		);
		expect(dependencyLine('package.name = "dotted"\n')).toBe(found("dotted"));
		expect(dependencyLine('[workspace]\nmembers = ["app"]\n')).toBe(unknown);
		expect(dependencyLine('[package\nname = "broken"\n')).toBe(unknown);
	});
	test("a go manifest with no module line still names placeholders", () => {
		const goFiles = shimFiles(
			feature,
			"go",
			"forge_target",
			locations("go 1.22\n"),
		);
		expect(goFiles[0]?.content).toContain(
			"// replace example.com/your/module => ../../../..",
		);
	});
});

describe("targetCommand", () => {
	test("the native kinds need none; exec kinds run from .forge/, elixir from the mix project", () => {
		expect(
			targetCommand("python", "forge_target.py", locations()),
		).toBeUndefined();
		expect(
			targetCommand("javascript", "forge_target.mjs", locations()),
		).toBeUndefined();
		expect(
			targetCommand("typescript", "forge_target.ts", locations()),
		).toBeUndefined();
		expect(targetCommand("ruby", "forge_target.rb", locations())).toBe(
			"ruby forge_target.rb",
		);
		expect(targetCommand("rust", "forge_target", locations())).toBe(
			"./forge_target/target/release/forge_target",
		);
		expect(targetCommand("go", "forge_target", locations())).toBe(
			"./forge_target/forge_target",
		);
		expect(
			targetCommand("elixir", "forge_target.exs", locations("defmodule")),
		).toBe(
			`sh -c 'cd "../../.." && MIX_QUIET=1 ELIXIR_ERL_OPTIONS="$ELIXIR_ERL_OPTIONS -logger default_handler [{config,#{type=>standard_error}}]" mix run "evals/a/.forge/forge_target.exs" "$@"' forge_target`,
		);
	});
	test("elixir with no mix.exs above the suite is refused by name", () => {
		expect(() =>
			targetCommand("elixir", "forge_target.exs", locations()),
		).toThrow("no mix.exs above /project/evals/a");
	});
	test("elixir refuses a path the shell command cannot quote", () => {
		expect(() =>
			targetCommand("elixir", "forge_target.exs", {
				forgeDirectory: "/project/it's/.forge",
				manifestDirectory: "/project",
				manifestText: "defmodule",
			}),
		).toThrow("cannot be quoted in the exec command");
	});
});

describe("findManifestDirectory and shimLocations", () => {
	test("walks up from the start to the nearest directory holding the manifest, or answers null", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "forge-shim-")));
		const forgeDirectory = join(root, "evals", "a", ".forge");
		await mkdir(forgeDirectory, { recursive: true });
		await writeFile(join(root, "Cargo.toml"), '[package]\nname = "my_app"\n');
		expect(await findManifestDirectory(forgeDirectory, "Cargo.toml")).toBe(
			root,
		);
		expect(
			await findManifestDirectory(forgeDirectory, "no-such-manifest.toml"),
		).toBeNull();
		expect(await shimLocations("rust", forgeDirectory)).toEqual({
			forgeDirectory,
			manifestDirectory: root,
			manifestText: '[package]\nname = "my_app"\n',
		});
		expect(await shimLocations("go", forgeDirectory)).toEqual({
			forgeDirectory,
			manifestDirectory: null,
			manifestText: null,
		});
		expect(await shimLocations("ruby", forgeDirectory)).toEqual({
			forgeDirectory,
			manifestDirectory: null,
			manifestText: null,
		});
	});
});
