import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { FORGE_VERSION } from "../../src/core/version";

describe("FORGE_VERSION", () => {
	test("is package.json's version", async () => {
		const packageJson = JSON.parse(await readFile("package.json", "utf8"));
		expect(FORGE_VERSION).toBe(packageJson.version);
	});
});
