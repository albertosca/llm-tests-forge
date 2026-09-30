import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");

// Stryker's bun runner takes an explicit file list; a core test left off it
// kills no mutants and raises no error.
test("stryker lists every test file under tests/core, nested ones included", async () => {
	const config: { bun: { testFiles: string[] } } = (
		await import(join(REPOSITORY, "stryker.config.mjs"))
	).default;
	const onDisk = [
		...new Bun.Glob("**/*.test.ts").scanSync({
			cwd: join(REPOSITORY, "tests/core"),
		}),
	]
		.map((name) => `./tests/core/${name}`)
		.sort();
	expect(onDisk.length).toBeGreaterThan(0);
	expect([...config.bun.testFiles].sort()).toEqual(onDisk);
});
