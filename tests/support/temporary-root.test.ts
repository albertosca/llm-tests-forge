import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createTemporaryRoot,
	makeWritable,
	removeTree,
} from "./temporary-root";

test("tmpdir() is a forge-test-run directory made for this run", () => {
	expect(basename(tmpdir()).startsWith("forge-test-run-")).toBe(true);
	expect(process.env.TMP).toBe(tmpdir());
	expect(process.env.TEMP).toBe(tmpdir());
});

test("a subprocess spawned by a test sees the same TMPDIR", () => {
	const child = Bun.spawnSync(
		["bun", "-e", "process.stdout.write(require('node:os').tmpdir())"],
		{ env: process.env },
	);
	expect(child.exitCode).toBe(0);
	expect(child.stdout.toString()).toBe(tmpdir());
});

test("removeTree removes a tree holding a read-only file in a read-only directory", () => {
	const root = mkdtempSync(join(tmpdir(), "forge-remove-"));
	const locked = join(root, "locked");
	mkdirSync(locked);
	writeFileSync(join(locked, "file.txt"), "x");
	chmodSync(join(locked, "file.txt"), 0o400);
	chmodSync(locked, 0o500);
	removeTree(root);
	expect(existsSync(root)).toBe(false);
});

test("removeTree never throws, even for a path it cannot remove", () => {
	expect(() =>
		removeTree(join(tmpdir(), "does-not-exist", "\0bad")),
	).not.toThrow();
});

test("makeWritable accepts a plain file", () => {
	const root = mkdtempSync(join(tmpdir(), "forge-writable-"));
	writeFileSync(join(root, "file.txt"), "x");
	makeWritable(join(root, "file.txt"));
	expect(readdirSync(root)).toEqual(["file.txt"]);
	rmSync(root, { recursive: true, force: true });
});

test("createTemporaryRoot points the three variables at a new directory and its remover deletes it", () => {
	const before = {
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
	};
	const remove = createTemporaryRoot();
	const created = tmpdir();
	Object.assign(process.env, before);
	expect(created).not.toBe(before.TMPDIR);
	expect(basename(created).startsWith("forge-test-run-")).toBe(true);
	expect(existsSync(created)).toBe(true);
	remove();
	expect(existsSync(created)).toBe(false);
});

test("a run in a known parent directory leaves no forge-* entry behind", () => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	const child = Bun.spawnSync(
		[
			"bun",
			"test",
			"./tests/support/leaky-fixture.ts",
			"--config=bunfig.packages.toml",
		],
		{ env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent } },
	);
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	expect(output).toContain("1 pass");
	expect(child.exitCode).toBe(0);
	expect(readdirSync(parent)).toEqual([]);
	rmSync(parent, { recursive: true, force: true });
});
