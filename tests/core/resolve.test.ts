import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../src/core/errors";
import { resolveSuite } from "../../src/core/resolve";
import { projectWith } from "../helpers/project";

describe("resolveSuite", () => {
	test("with no --suite, the suite is the current directory's .forge, and the project is found above it", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		const resolution = await resolveSuite({
			cwd: join(root, "evals", "a"),
		});
		expect(resolution.forgeDirectory).toBe(join(root, "evals", "a", ".forge"));
		expect(resolution.project?.root).toBe(root);
	});

	test("outside any project there is no project, and the verbs behave as today", async () => {
		const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
		expect(await resolveSuite({ cwd: outside })).toEqual({
			forgeDirectory: join(outside, ".forge"),
			project: null,
		});
	});

	test("--suite resolves against the project root from any subdirectory, and refuses a path that is not registered", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a, evals/b]\n",
		);
		await mkdir(join(root, "src", "deep"), { recursive: true });
		expect(
			(
				await resolveSuite({
					cwd: join(root, "src", "deep"),
					suite: "evals/b/",
				})
			).forgeDirectory,
		).toBe(join(root, "evals", "b", ".forge"));
		await expect(resolveSuite({ cwd: root, suite: "evals/c" })).rejects.toThrow(
			'suite "evals/c" is not registered in',
		);
		await expect(resolveSuite({ cwd: root, suite: "evals/c" })).rejects.toThrow(
			"registered: evals/a, evals/b",
		);
	});

	test("the project root is a suite named '.', however it is spelled", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: ['.']\n",
		);
		for (const spelling of [".", "./", "./."]) {
			expect(
				(await resolveSuite({ cwd: join(root, "deep"), suite: spelling }))
					.forgeDirectory,
			).toBe(join(root, ".forge"));
		}
	});

	test("--suite refuses a backslash path with the message forge.yaml's entries get", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites: [evals/a]\n",
		);
		await expect(
			resolveSuite({ cwd: root, suite: "evals\\a" }),
		).rejects.toThrow(
			'suite "evals\\a" uses a backslash; write paths with forward slashes',
		);
	});

	test("--suite with no forge.yaml above is a usage error that says where it looked", async () => {
		const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
		await expect(
			resolveSuite({ cwd: outside, suite: "x" }),
		).rejects.toBeInstanceOf(UsageError);
		await expect(resolveSuite({ cwd: outside, suite: "x" })).rejects.toThrow(
			`--suite needs a forge.yaml; none found above ${outside}`,
		);
	});
});
