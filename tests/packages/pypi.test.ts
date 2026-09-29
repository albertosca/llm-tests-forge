/**
 * The PyPI wheels, end to end: the host binary compiled, the wheels built
 * from it by `uv build --wheel`, and the host wheel installed into a
 * temporary venv, where the console entry must run the binary; a wheel for
 * another platform must be refused by the installer, and the build must
 * refuse to run without its two variables. Off by default; run with `bun run
 * test:packages` (sets FORGE_PACKAGES=1). It needs uv on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { PYPI_MANIFESTS, stampVersion } from "../../scripts/release/version";
import { renderWheels } from "../../scripts/release/wheels";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform && target.npmCpu === process.arch,
);
// A target no installer on this machine accepts: Windows from anywhere else, Linux from Windows.
const FOREIGN = RELEASE_TARGETS.find((target) =>
	process.platform === "win32"
		? target.npmOs === "linux" && target.npmCpu === "x64"
		: target.npmOs === "win32",
);

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(
	command: string[],
	directory: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<Finished> {
	const child = Bun.spawn(command, {
		cwd: directory,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function mustRun(command: string[], directory: string): Promise<string> {
	const finished = await run(command, directory);
	if (finished.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} exited ${finished.exitCode}: ${finished.stderr}`,
		);
	return finished.stdout;
}

/** The working directories the tests created; removed once, after the last test. */
const workDirectories: string[] = [];
afterAll(async () => {
	for (const directory of workDirectories)
		await rm(directory, { recursive: true, force: true });
});

interface Built {
	work: string;
	hostWheel: string;
	foreignWheel: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host and the foreign wheel, built once for all the tests; the foreign one carries the host binary under its own name. */
function builtWheels(): Promise<Built> {
	builtOnce ??= (async () => {
		if (HOST === undefined || FOREIGN === undefined)
			throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-pypi-e2e-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await buildBinaries(binaries, HOST.bunTarget);
		await Bun.write(
			join(binaries, FOREIGN.assetName),
			Bun.file(join(binaries, HOST.assetName)),
		);
		const [hostWheel, foreignWheel] = await renderWheels(
			binaries,
			join(work, "wheels"),
			REPOSITORY,
			"uv",
			[HOST, FOREIGN],
		);
		if (hostWheel === undefined || foreignWheel === undefined)
			throw new Error("uv build wrote no wheel");
		return { work, hostWheel, foreignWheel };
	})();
	return builtOnce;
}

function venvPaths(venv: string) {
	const directory = join(
		venv,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const suffix = process.platform === "win32" ? ".exe" : "";
	return {
		python: join(directory, `python${suffix}`),
		entry: join(directory, `llm-tests-forge${suffix}`),
	};
}

/** A fresh venv under the shared work directory with the host wheel installed. */
async function installedVenv(): Promise<ReturnType<typeof venvPaths>> {
	const { work, hostWheel } = await builtWheels();
	const venv = await mkdtemp(join(work, "venv-"));
	const paths = venvPaths(venv);
	await mustRun(["uv", "venv", venv], work);
	await mustRun(
		["uv", "pip", "install", "--offline", "--python", paths.python, hostWheel],
		work,
	);
	return paths;
}

function withoutForgeWheelVariables(): Record<string, string | undefined> {
	const environment: Record<string, string | undefined> = { ...process.env };
	delete environment.FORGE_WHEEL_PLATFORM;
	delete environment.FORGE_WHEEL_BINARY;
	return environment;
}

describe.skipIf(!packages)("pypi wheels", () => {
	test("the host wheel installed into a temporary venv runs the binary through the console entry", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		expect(await run([paths.entry, "--version"], work)).toEqual({
			exitCode: 0,
			stdout: `${FORGE_VERSION}\n`,
			stderr: "",
		});
		expect(
			await run([paths.python, "-m", "llm_tests_forge", "--version"], work),
		).toEqual({ exitCode: 0, stdout: `${FORGE_VERSION}\n`, stderr: "" });
	}, 600_000);

	test("a wheel for another platform is refused by the installer, so the tag is real", async () => {
		const { work, foreignWheel } = await builtWheels();
		const venv = await mkdtemp(join(work, "venv-"));
		const paths = venvPaths(venv);
		await mustRun(["uv", "venv", venv], work);
		const finished = await run(
			[
				"uv",
				"pip",
				"install",
				"--offline",
				"--python",
				paths.python,
				foreignWheel,
			],
			work,
		);
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(
			"dependency is incompatible with the current platform",
		);
	}, 600_000);

	test("the wheel's own metadata is platform-specific: WHEEL says Root-Is-Purelib false and the target's tag, and the LICENSE ships inside", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const paths = await installedVenv();
		const { work, hostWheel } = await builtWheels();
		const inspected = JSON.parse(
			await mustRun(
				[
					paths.python,
					"-c",
					[
						"import json, sys, zipfile",
						"archive = zipfile.ZipFile(sys.argv[1])",
						"names = archive.namelist()",
						"wheel = next(name for name in names if name.endswith('.dist-info/WHEEL'))",
						"print(json.dumps({'wheel': archive.read(wheel).decode(), 'license': archive.read('llm_tests_forge/LICENSE').decode() if 'llm_tests_forge/LICENSE' in names else None}))",
					].join("\n"),
					hostWheel,
				],
				work,
			),
		);
		expect(inspected.wheel.split("\n")).toContain("Root-Is-Purelib: false");
		expect(inspected.wheel.split("\n")).toContain(
			`Tag: py3-none-${HOST.wheelTag}`,
		);
		expect(inspected.license).toBe(
			await Bun.file(join(REPOSITORY, "LICENSE")).text(),
		);
	}, 600_000);

	test("a relative FORGE_WHEEL_BINARY is refused naming it, since the build runs in another directory than the caller's", async () => {
		const { work } = await builtWheels();
		const finished = await run(
			[
				"uv",
				"build",
				"--wheel",
				"--out-dir",
				join(work, "refused"),
				join(REPOSITORY, "packages/pypi"),
			],
			work,
			{
				...withoutForgeWheelVariables(),
				FORGE_WHEEL_PLATFORM: "win_amd64",
				FORGE_WHEEL_BINARY: "binaries/llm-tests-forge",
			},
		);
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(
			"FORGE_WHEEL_BINARY must be an absolute path: binaries/llm-tests-forge",
		);
	}, 600_000);

	test("a prerelease version (0.1.0-rc.1) is built by real uv under the PEP 440 name renderWheels predicts", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-pypi-prerelease-"));
		workDirectories.push(work);
		const root = join(work, "root");
		await cp(join(REPOSITORY, "packages/pypi"), join(root, "packages/pypi"), {
			recursive: true,
		});
		await writeFile(
			join(root, "package.json"),
			'{ "version": "0.1.0-rc.1" }\n',
		);
		await cp(join(REPOSITORY, "LICENSE"), join(root, "LICENSE"));
		await stampVersion(root, PYPI_MANIFESTS);
		const binaries = join(work, "binaries");
		await mkdir(binaries);
		await writeFile(join(binaries, HOST.assetName), "a stand-in binary\n");
		const written = await renderWheels(
			binaries,
			join(work, "wheels"),
			root,
			"uv",
			[HOST],
		);
		expect(written).toEqual([
			join(
				work,
				"wheels",
				`llm_tests_forge-0.1.0rc1-py3-none-${HOST.wheelTag}.whl`,
			),
		]);
		expect(await Bun.file(written[0] ?? "").exists()).toBe(true);
	}, 600_000);

	test("the build refuses to run without the platform variable, then without the binary variable, naming each", async () => {
		const { work } = await builtWheels();
		const missingPlatform = await run(
			[
				"uv",
				"build",
				"--wheel",
				"--out-dir",
				join(work, "refused"),
				join(REPOSITORY, "packages/pypi"),
			],
			work,
			{
				...withoutForgeWheelVariables(),
				FORGE_WHEEL_BINARY: join(work, "binaries"),
			},
		);
		expect(missingPlatform.exitCode).not.toBe(0);
		expect(missingPlatform.stderr).toContain("FORGE_WHEEL_PLATFORM is not set");
		const missingBinary = await run(
			[
				"uv",
				"build",
				"--wheel",
				"--out-dir",
				join(work, "refused"),
				join(REPOSITORY, "packages/pypi"),
			],
			work,
			{ ...withoutForgeWheelVariables(), FORGE_WHEEL_PLATFORM: "win_amd64" },
		);
		expect(missingBinary.exitCode).not.toBe(0);
		expect(missingBinary.stderr).toContain("FORGE_WHEEL_BINARY is not set");
	}, 600_000);

	test("the unsupported message names the platform the way the npm package does, for every spelling Python reports", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		// [sys.platform, platform.machine(), the name in the message]
		const cases: [string, string, string][] = [
			["darwin", "arm64", "darwin-arm64"],
			["darwin", "x86_64", "darwin-x64"],
			["linux", "x86_64", "linux-x64"],
			["linux", "aarch64", "linux-arm64"],
			["win32", "AMD64", "win32-x64"],
			["linux", "i686", "linux-i686"],
		];
		for (const [systemPlatform, machine, name] of cases)
			expect(
				(
					await mustRun(
						[
							paths.python,
							"-c",
							"import sys, llm_tests_forge; print(llm_tests_forge.platform_name(sys.argv[1], sys.argv[2]))",
							systemPlatform,
							machine,
						],
						work,
					)
				).trim(),
			).toBe(name);
	}, 600_000);

	test("with the binary removed from the installed package, the entry names the platform and the install script and exits 1", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const paths = await installedVenv();
		const { work } = await builtWheels();
		const located = await mustRun(
			[
				paths.python,
				"-c",
				"import llm_tests_forge; print(llm_tests_forge.binary_path())",
			],
			work,
		);
		await rm(located.trim());
		expect(await run([paths.entry, "--version"], work)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `llm-tests-forge has no binary for ${process.platform}-${process.arch}; see https://github.com/albertosca/llm-tests-forge for install.sh\n`,
		});
	}, 600_000);
});

const INTERRUPT_COUNTING_CHILD = `#!/usr/bin/env python3
import signal, sys, time
count = 0
def on_interrupt(signal_number, frame):
    global count
    count += 1
    print("interrupt", count, flush=True)
    if count == 2:
        sys.exit(130)
signal.signal(signal.SIGINT, on_interrupt)
print("ready", flush=True)
while True:
    time.sleep(1)
`;

const SELF_TERMINATING_CHILD = `#!/usr/bin/env python3
import os, signal, time
os.kill(os.getpid(), signal.SIGTERM)
time.sleep(30)
`;

/** The Windows path of the entry (run_attached), started as its own process group leader the way a terminal's foreground job is. */
async function startAttached(childSource: string) {
	const paths = await installedVenv();
	const { work } = await builtWheels();
	const childPath = join(
		work,
		`child-${Math.random().toString(36).slice(2)}.py`,
	);
	await writeFile(childPath, childSource, { mode: 0o755 });
	const launcher = spawn(
		paths.python,
		[
			"-c",
			"import sys; from llm_tests_forge import run_attached; sys.exit(run_attached(sys.argv[1], []))",
			childPath,
		],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	launcher.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const finished = new Promise<number | null>((resolveExit) => {
		launcher.on("close", (code) => resolveExit(code));
	});
	let exited = false;
	finished.then(() => {
		exited = true;
	});
	async function waitFor(text: string): Promise<void> {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (output.includes(text)) return;
			await Bun.sleep(20);
		}
		throw new Error(`never saw ${JSON.stringify(text)}; output: ${output}`);
	}
	function signalGroup(signalName: NodeJS.Signals): void {
		if (launcher.pid === undefined) throw new Error("launcher did not start");
		process.kill(-launcher.pid, signalName);
	}
	return { finished, waitFor, signalGroup, hasExited: () => exited };
}

describe.skipIf(!packages || process.platform === "win32")(
	"the attached runner used where execv does not replace the process",
	() => {
		test("a Ctrl+C sent to the whole process group leaves the runner attached: the child sees each one, and the second ends both with 130", async () => {
			const launcher = await startAttached(INTERRUPT_COUNTING_CHILD);
			await launcher.waitFor("ready");
			launcher.signalGroup("SIGINT");
			await launcher.waitFor("interrupt 1");
			await Bun.sleep(300);
			expect(launcher.hasExited()).toBe(false);
			launcher.signalGroup("SIGINT");
			expect(await launcher.finished).toBe(130);
		}, 600_000);

		test("a child killed by SIGTERM makes the runner exit 143, the way a shell reports it", async () => {
			const launcher = await startAttached(SELF_TERMINATING_CHILD);
			expect(await launcher.finished).toBe(143);
		}, 600_000);
	},
);
