/**
 * Not a test of the project: a deliberately leaky test file that the
 * temporary-root test runs as a subprocess. It creates `forge-` directories
 * and never removes them, which is exactly what the preload must clean up.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("leaves temporary directories behind", () => {
	const leaked = mkdtempSync(join(tmpdir(), "forge-leak-"));
	writeFileSync(join(leaked, "file.txt"), "left behind");
	expect(leaked.startsWith(tmpdir())).toBe(true);
});
