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
import { REPOSITORY } from "../helpers/repository";
import {
	createTemporaryRoot,
	makeWritable,
	processIsAlive,
	removeAbandonedRuns,
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
}, 30_000);

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

test("the run directory's name carries the pid of the process that owns it", () => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	const before = {
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
	};
	const remove = createTemporaryRoot(parent);
	const created = tmpdir();
	Object.assign(process.env, before);
	expect(
		created.startsWith(join(parent, `forge-test-run-${process.pid}-`)),
	).toBe(true);
	remove();
	rmSync(parent, { recursive: true, force: true });
});

test("processIsAlive: this process and one owned by another user are alive, a reaped child is not", async () => {
	expect(processIsAlive(process.pid)).toBe(true);
	// pid 1 belongs to root: signalling it fails with EPERM, which still means alive.
	expect(processIsAlive(1)).toBe(true);
	const child = Bun.spawn(["true"]);
	await child.exited;
	expect(processIsAlive(child.pid)).toBe(false);
}, 30_000);

test("at start, a run directory whose owner is dead is removed; a live owner's, one without a pid, and other entries are kept", () => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	const deadPid = 999_999_001;
	const kept = [
		`forge-test-run-${process.pid}-live01`,
		"forge-test-run-AbC123",
		`forge-hex-e2e-${deadPid}`,
		"unrelated",
	];
	for (const name of [`forge-test-run-${deadPid}-dead01`, ...kept]) {
		mkdirSync(join(parent, name));
		writeFileSync(join(parent, name, "file.txt"), "x");
	}
	// A read-only leftover is removed too, as removeTree removes any tree.
	chmodSync(join(parent, `forge-test-run-${deadPid}-dead01`), 0o500);
	removeAbandonedRuns(parent, (pid) => pid !== deadPid);
	expect(readdirSync(parent).sort()).toEqual([...kept].sort());
	rmSync(parent, { recursive: true, force: true });
});

test("a parent that cannot be listed is left alone without throwing", () => {
	expect(() =>
		removeAbandonedRuns(join(tmpdir(), "does-not-exist"), () => false),
	).not.toThrow();
});

test("a SIGKILLed run leaves its directory, and the next run's start removes it", async () => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	const environment = {
		...process.env,
		TMPDIR: parent,
		TMP: parent,
		TEMP: parent,
	};
	const hanging = Bun.spawn(
		[
			"bun",
			"test",
			"./tests/support/hanging-fixture.ts",
			"--config=bunfig.packages.toml",
		],
		{ cwd: REPOSITORY, env: environment, stdout: "ignore", stderr: "ignore" },
	);
	const started = async (): Promise<string> => {
		for (;;) {
			const runDirectory = readdirSync(parent).find((name) =>
				existsSync(join(parent, name, "started")),
			);
			if (runDirectory !== undefined) return runDirectory;
			await Bun.sleep(50);
		}
	};
	const runDirectory = await started();
	hanging.kill("SIGKILL");
	expect(await hanging.exited).not.toBe(0);
	expect(readdirSync(parent)).toEqual([runDirectory]);
	const next = Bun.spawnSync(
		[
			"bun",
			"test",
			"./tests/support/leaky-fixture.ts",
			"--config=bunfig.packages.toml",
		],
		{ cwd: REPOSITORY, env: environment },
	);
	expect(next.exitCode).toBe(0);
	expect(readdirSync(parent)).toEqual([]);
	rmSync(parent, { recursive: true, force: true });
}, 30_000);

test("a run in a known parent directory leaves no forge-* entry behind", () => {
	const parent = mkdtempSync(join(tmpdir(), "parent-"));
	const child = Bun.spawnSync(
		[
			"bun",
			"test",
			"./tests/support/leaky-fixture.ts",
			"--config=bunfig.packages.toml",
		],
		{
			cwd: REPOSITORY,
			env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent },
		},
	);
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	expect(output).toContain("1 pass");
	expect(child.exitCode).toBe(0);
	expect(readdirSync(parent)).toEqual([]);
	rmSync(parent, { recursive: true, force: true });
}, 30_000);
