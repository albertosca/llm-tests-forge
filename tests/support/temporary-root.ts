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

/** A run directory's name: `forge-test-run-<pid of its owner>-<random>`. */
const RUN_DIRECTORY = /^forge-test-run-(\d+)-[^-]+$/;

/**
 * Whether a process with `pid` exists: signal 0 checks without sending
 * anything. EPERM means it exists under another user, so it counts as alive.
 */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * Removes the run directories in `parent` whose owning process no longer
 * exists: what a SIGKILLed run (which runs no cleanup) left behind. A live
 * owner's directory is never touched, and neither is a name without a pid
 * (an older checkout's run, which may still be going). Never throws.
 */
export function removeAbandonedRuns(
	parent: string,
	isAlive: (pid: number) => boolean = processIsAlive,
): void {
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	for (const name of names) {
		const owner = RUN_DIRECTORY.exec(name)?.[1];
		if (owner !== undefined && !isAlive(Number(owner)))
			removeTree(join(parent, name));
	}
}

/**
 * Removes the run directories abandoned in `parent` (by default the current
 * temporary directory), creates one fresh directory there named after this
 * process, points TMPDIR, TMP and TEMP at it, and returns the function that
 * removes it.
 */
export function createTemporaryRoot(parent: string = tmpdir()): () => void {
	removeAbandonedRuns(parent);
	const runRoot = mkdtempSync(join(parent, `forge-test-run-${process.pid}-`));
	for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = runRoot;
	return () => removeTree(runRoot);
}
