/**
 * The pieces behind the preload in `preload-temporary-root.ts`. Node's and
 * bun's `tmpdir()` read `TMPDIR` on every call, so pointing it at one private
 * directory redirects every later `mkdtemp(join(tmpdir(), ...))` and every
 * spawned subprocess, without touching a single test.
 */
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes every directory and file under `root` writable, so a removal can succeed. */
export function makeWritable(root: string): void {
	const stat = lstatSync(root);
	if (stat.isSymbolicLink()) return;
	chmodSync(root, 0o700);
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(root)) makeWritable(join(root, entry));
}

/** Removes `root` recursively; on failure makes it writable and retries once. Never throws. */
export function removeTree(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
		return;
	} catch {
		// fall through to the retry below
	}
	try {
		makeWritable(root);
		rmSync(root, { recursive: true, force: true });
	} catch {
		// an exit handler must not throw
	}
}

/**
 * Creates one fresh directory inside the current temporary directory, points
 * TMPDIR, TMP and TEMP at it, and returns the function that removes it.
 */
export function createTemporaryRoot(): () => void {
	const runRoot = mkdtempSync(join(tmpdir(), "forge-test-run-"));
	for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = runRoot;
	return () => removeTree(runRoot);
}
