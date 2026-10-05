/**
 * Not a test of the project: a test file that the temporary-root test runs
 * as a subprocess and then SIGKILLs. It marks the run's temporary directory
 * as started and waits, so the kill lands while the run is alive and no
 * cleanup of the run's own can follow.
 */
import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("waits to be killed", async () => {
	writeFileSync(join(tmpdir(), "started"), String(process.pid));
	await Bun.sleep(120_000);
}, 180_000);
