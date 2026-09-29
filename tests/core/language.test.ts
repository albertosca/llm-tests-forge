import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage } from "../../src/core/language";

async function directoryWith(files: string[]): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-language-"));
	for (const file of files) await writeFile(join(directory, file), "");
	return directory;
}

describe("detectLanguage", () => {
	test("reads the manifest, backend manifests first, typescript when tsconfig.json sits next to package.json", async () => {
		expect(
			await detectLanguage(await directoryWith(["mix.exs", "package.json"])),
		).toEqual({ language: "elixir", manifest: "mix.exs" });
		expect(
			await detectLanguage(await directoryWith(["Gemfile", "package.json"])),
		).toEqual({ language: "ruby", manifest: "Gemfile" });
		expect(
			await detectLanguage(await directoryWith(["requirements.txt"])),
		).toEqual({ language: "python", manifest: "requirements.txt" });
		expect(
			await detectLanguage(
				await directoryWith(["package.json", "tsconfig.json"]),
			),
		).toEqual({ language: "typescript", manifest: "package.json" });
		expect(await detectLanguage(await directoryWith(["package.json"]))).toEqual(
			{ language: "javascript", manifest: "package.json" },
		);
		expect(await detectLanguage(await directoryWith(["Cargo.toml"]))).toEqual({
			language: "rust",
			manifest: "Cargo.toml",
		});
		expect(await detectLanguage(await directoryWith(["go.mod"]))).toEqual({
			language: "go",
			manifest: "go.mod",
		});
		expect(await detectLanguage(await directoryWith([]))).toBeNull();
		const directoryNamedLikeManifests = await directoryWith([]);
		for (const name of ["mix.exs", "Gemfile", "package.json"])
			await mkdir(join(directoryNamedLikeManifests, name));
		expect(await detectLanguage(directoryNamedLikeManifests)).toBeNull();
	});

	test("each python manifest is found, and the order among the others holds", async () => {
		expect(
			await detectLanguage(await directoryWith(["pyproject.toml"])),
		).toEqual({ language: "python", manifest: "pyproject.toml" });
		expect(await detectLanguage(await directoryWith(["setup.py"]))).toEqual({
			language: "python",
			manifest: "setup.py",
		});
		expect(
			await detectLanguage(await directoryWith(["Cargo.toml", "go.mod"])),
		).toEqual({ language: "rust", manifest: "Cargo.toml" });
		expect(
			await detectLanguage(await directoryWith(["go.mod", "Gemfile"])),
		).toEqual({ language: "go", manifest: "go.mod" });
		expect(
			await detectLanguage(await directoryWith(["Gemfile", "pyproject.toml"])),
		).toEqual({ language: "ruby", manifest: "Gemfile" });
		expect(
			await detectLanguage(
				await directoryWith(["pyproject.toml", "package.json"]),
			),
		).toEqual({ language: "python", manifest: "pyproject.toml" });
	});
});
