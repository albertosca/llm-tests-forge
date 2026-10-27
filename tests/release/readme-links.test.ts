import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");
const READMES = ["README.md", "README.pt.md"];

async function readReadme(name: string): Promise<string> {
	return readFile(join(REPOSITORY, name), "utf8");
}

function relativeTargets(markdown: string): string[] {
	const targets: string[] = [];
	for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
		const target = match[1] ?? "";
		if (/^(https?:|mailto:|#)/.test(target)) continue;
		targets.push(target.split("#")[0] ?? "");
	}
	return targets;
}

function headings(markdown: string, level: string): string[] {
	return markdown.split("\n").filter((line) => line.startsWith(`${level} `));
}

describe.each(READMES)("%s", (name) => {
	test("every relative link and image points at a file that exists", async () => {
		const markdown = await readReadme(name);
		const targets = relativeTargets(markdown);
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(existsSync(join(dirname(join(REPOSITORY, name)), target))).toBe(
				true,
			);
		}
	});

	test("shows the recorded demo", async () => {
		expect(await readReadme(name)).toContain("![");
		expect(await readReadme(name)).toContain("assets/demo.gif");
	});

	test("links the community files", async () => {
		const targets = relativeTargets(await readReadme(name));
		for (const file of [
			"CONTRIBUTING.md",
			"SECURITY.md",
			"CODE_OF_CONDUCT.md",
			"CHANGELOG.md",
		]) {
			expect(targets).toContain(file);
		}
	});
});

describe("the two READMEs", () => {
	test("have the same sections, in the same number", async () => {
		const [english, portuguese] = await Promise.all(READMES.map(readReadme));
		for (const level of ["##", "###"]) {
			expect(headings(portuguese ?? "", level).length).toBe(
				headings(english ?? "", level).length,
			);
		}
	});

	test("link each other from the first line", async () => {
		const [english, portuguese] = await Promise.all(READMES.map(readReadme));
		for (const markdown of [english ?? "", portuguese ?? ""]) {
			const firstLine = markdown.split("\n")[0] ?? "";
			expect(firstLine).toContain("](README.md)");
			expect(firstLine).toContain("](README.pt.md)");
		}
	});
});
