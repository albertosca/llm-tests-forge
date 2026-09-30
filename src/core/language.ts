import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Language } from "./schemas";

/**
 * Backend manifests come before package.json: a Phoenix or Rails project
 * carries a package.json for its assets, and its language is not JavaScript.
 */
const MANIFESTS: { manifest: string; language: Language }[] = [
	{ manifest: "mix.exs", language: "elixir" },
	{ manifest: "Cargo.toml", language: "rust" },
	{ manifest: "go.mod", language: "go" },
	{ manifest: "Gemfile", language: "ruby" },
	{ manifest: "pyproject.toml", language: "python" },
	{ manifest: "setup.py", language: "python" },
	{ manifest: "requirements.txt", language: "python" },
];

async function fileExists(path: string): Promise<boolean> {
	return stat(path).then(
		(found) => found.isFile(),
		// Stryker disable next-line ArrowFunction: every caller reads the result as a condition (`if`, or the ternary on `typed`), where undefined is false too.
		() => false,
	);
}

/** The language of the project at `root`, read from its manifest, or null when no manifest is there. */
export async function detectLanguage(
	root: string,
): Promise<{ language: Language; manifest: string } | null> {
	for (const { manifest, language } of MANIFESTS) {
		if (await fileExists(join(root, manifest))) return { language, manifest };
	}
	if (await fileExists(join(root, "package.json"))) {
		const typed = await fileExists(join(root, "tsconfig.json"));
		return {
			language: typed ? "typescript" : "javascript",
			manifest: "package.json",
		};
	}
	return null;
}
