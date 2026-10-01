/**
 * Guards for the premises some `Stryker disable` reasons in src/core rest
 * on, where the premise lives in distant code a mutant cannot see. Each
 * test reads the source, so a change that breaks the premise fails here
 * instead of turning a disabled mutant into a silent bug.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPOSITORY } from "../helpers/repository";

/** Every TypeScript file under src/, with its text. */
async function sources(): Promise<{ path: string; text: string }[]> {
	const found: { path: string; text: string }[] = [];
	for (const path of new Bun.Glob("src/**/*.ts").scanSync({
		cwd: REPOSITORY,
	}))
		found.push({
			path,
			text: await readFile(join(REPOSITORY, path), "utf8"),
		});
	expect(found.length).toBeGreaterThan(0);
	return found;
}

describe("premises of disabled mutants", () => {
	test("schemas.ts: nothing reads a zod issue's code, so the custom codes there are never read", async () => {
		const readers = (await sources()).filter(({ text }) =>
			/\bissues?\b[^\n]*\.code\b|\bissue\.code\b/.test(text),
		);
		expect(readers.map(({ path }) => path)).toEqual([]);
	});

	test("estimate.ts: every estimateSuite call passes the selection selectCases returned, so a rubric case always carries its rubric", async () => {
		const callers = (await sources()).filter(
			({ path, text }) =>
				path !== "src/core/estimate.ts" && text.includes("estimateSuite({"),
		);
		expect(callers.map(({ path }) => path).sort()).toEqual([
			"src/cli/commands/estimate.ts",
			"src/cli/commands/report.ts",
		]);
		for (const { text } of callers) {
			expect(text).toMatch(/const selection = selectCases\(/);
			expect(text).toMatch(/estimateSuite\(\{\s*suite,\s*selection,/);
		}
	});

	test("files.ts: stampSuite's one caller passes FORGE_VERSION, so the stamp is one-line text yaml writes plain", async () => {
		const calls = (await sources()).flatMap(({ path, text }) =>
			[...text.matchAll(/await stampSuite\(([^)]*)\)/g)].map(
				(match) => `${path}: ${match[1]}`,
			),
		);
		expect(calls).toEqual([
			"src/cli/main.ts: context.forgeDirectory, FORGE_VERSION",
		]);
	});

	test("files.ts: every hasCode caller compares the code with a string literal, so a non-string code reads as no code", async () => {
		const files = (await sources()).find(
			({ path }) => path === "src/core/files.ts",
		);
		const comparisons = [
			...(files?.text ?? "").matchAll(/error\.code\b([^\n]*)/g),
		].map((match) => match[1]?.trim() ?? "");
		expect(comparisons.length).toBeGreaterThan(0);
		for (const comparison of comparisons)
			expect(comparison).toMatch(/^(=== "[A-Z]+"|: undefined;)/);
	});
});
