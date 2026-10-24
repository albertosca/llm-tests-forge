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
import { basename, join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { PYPI_MANIFESTS, stampVersion } from "../../scripts/release/version";
import {
	pep440Version,
	renderFallbackWheel,
	renderWheels,
} from "../../scripts/release/wheels";
import { FORGE_VERSION } from "../../src/core/version";
import { muslMessage } from "../helpers/platform-messages";

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
	fallbackWheel: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host, the foreign and the fallback wheel, built once for all the tests; the foreign one carries the host binary under its own name. */
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
		const fallbackWheel = await renderFallbackWheel(
			join(work, "fallbacks"),
			REPOSITORY,
			"uv",
		);
		return { work, hostWheel, foreignWheel, fallbackWheel };
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
		// A compressed tag set such as manylinux_2_17_x86_64.manylinux2014_x86_64
		// is written as one Tag line per platform tag.
		for (const platformTag of HOST.wheelTag.split(".")) {
			expect(inspected.wheel.split("\n")).toContain(
				`Tag: py3-none-${platformTag}`,
			);
		}
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
			// Python spells 32-bit x86 i386 to i686 (x86 on Windows); npm says ia32.
			["linux", "i686", "linux-ia32"],
			["linux", "i386", "linux-ia32"],
			["win32", "x86", "win32-ia32"],
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

/** A directory holding copies of `wheels` and nothing else, for `--find-links`: a local index of exactly these files. */
async function localIndex(wheels: string[]): Promise<string> {
	const { work } = await builtWheels();
	const index = await mkdtemp(join(work, "index-"));
	for (const wheel of wheels) await cp(wheel, join(index, basename(wheel)));
	return index;
}

/**
 * The requirement every install by name uses: the name pinned to this
 * version, as PEP 440 spells it. A bare name would skip a prerelease
 * (0.1.0rc2) wherever a release of it is also in the index, and the pin
 * still leaves the installer to choose among that version's wheels.
 */
const REQUIREMENT = `llm-tests-forge==${pep440Version(FORGE_VERSION)}`;

/** A fresh venv with llm-tests-forge installed by name from `index` alone, so the installer chooses the wheel, as `pip install llm-tests-forge` does. */
async function venvInstalledFrom(
	index: string,
): Promise<ReturnType<typeof venvPaths>> {
	const { work } = await builtWheels();
	const venv = await mkdtemp(join(work, "venv-"));
	const paths = venvPaths(venv);
	await mustRun(["uv", "venv", venv], work);
	await mustRun(
		[
			"uv",
			"pip",
			"install",
			"--offline",
			"--no-index",
			"--find-links",
			index,
			"--python",
			paths.python,
			REQUIREMENT,
		],
		work,
	);
	return paths;
}

/** The `Tag:` lines of the WHEEL file of the llm-tests-forge installed for `python`, sorted: the wheel the installer chose. Their order is the build's (CI's hatchling writes manylinux2014 first), so it carries no meaning. */
async function installedTags(python: string, work: string): Promise<string[]> {
	const wheelText = await mustRun(
		[
			python,
			"-c",
			"from importlib.metadata import distribution; print(distribution('llm-tests-forge').read_text('WHEEL'))",
		],
		work,
	);
	return wheelText
		.split("\n")
		.filter((line) => line.startsWith("Tag: "))
		.sort();
}

/** What the fallback wheel says on a platform that has a platform wheel (`name` in npm's spelling, `platformTag` that wheel's tag). */
function fallbackWheelChosenMessage(name: string, platformTag: string): string {
	return `llm-tests-forge: this is the py3-none-any fallback wheel, which has no binary, but ${name} has a platform wheel (${platformTag}); the installer chose the fallback because no wheel matched this platform: the OS version may be older than the wheel's minimum, the glibc older than 2.17, the pip too old to know ${platformTag}, or the installer was asked for another platform (pip --platform, uv --python-platform). Upgrade pip (python -m pip install --upgrade pip) and reinstall (pip install llm-tests-forge), or ask for that wheel with --platform ${platformTag}`;
}

/** missing_binary_message(system_platform, machine, libc, fallback) as the installed package computes it, through `python`. */
async function pythonMessage(
	python: string,
	work: string,
	systemPlatform: string,
	machine: string,
	libc: string,
	fallback: boolean,
): Promise<string> {
	return (
		await mustRun(
			[
				python,
				"-c",
				"import sys, llm_tests_forge; print(llm_tests_forge.missing_binary_message(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == 'fallback'))",
				systemPlatform,
				machine,
				libc,
				fallback ? "fallback" : "platform",
			],
			work,
		)
	).trimEnd();
}

describe.skipIf(!packages)("the fallback wheel", () => {
	test("with the host wheel and the fallback in one local index, uv installs the host wheel, and the entry runs the binary", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { work, hostWheel, fallbackWheel } = await builtWheels();
		const paths = await venvInstalledFrom(
			await localIndex([fallbackWheel, hostWheel]),
		);
		expect(await installedTags(paths.python, work)).toEqual(
			HOST.wheelTag
				.split(".")
				.map((platformTag) => `Tag: py3-none-${platformTag}`)
				.sort(),
		);
		expect(await run([paths.entry, "--version"], work)).toEqual({
			exitCode: 0,
			stdout: `${FORGE_VERSION}\n`,
			stderr: "",
		});
	}, 600_000);

	// This machine has a platform wheel, so the installed fallback says so; the
	// plain message for a platform without one is pinned by the message tests.
	test("with only the fallback in the index, uv installs it, and the entry exits 1 naming the platform wheel this machine has", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { work, fallbackWheel } = await builtWheels();
		const paths = await venvInstalledFrom(await localIndex([fallbackWheel]));
		expect(await installedTags(paths.python, work)).toEqual([
			"Tag: py3-none-any",
		]);
		const expected = `${fallbackWheelChosenMessage(`${process.platform}-${process.arch}`, HOST.wheelTag.split(".")[0] ?? "")}\n`;
		expect(await run([paths.entry, "--version"], work)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: expected,
		});
		expect(
			await run([paths.python, "-m", "llm_tests_forge", "--version"], work),
		).toEqual({ exitCode: 1, stdout: "", stderr: expected });
	}, 600_000);

	test("the entry's table of platform wheels is the release targets' (scripts/release/targets.ts), by npm name and first platform tag", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		expect(
			JSON.parse(
				await mustRun(
					[
						paths.python,
						"-c",
						"import json, llm_tests_forge; print(json.dumps(llm_tests_forge.PLATFORM_WHEEL_TAGS))",
					],
					work,
				),
			),
		).toEqual(
			Object.fromEntries(
				RELEASE_TARGETS.map((target) => [
					`${target.npmOs}-${target.npmCpu}`,
					target.wheelTag.split(".")[0],
				]),
			),
		);
	}, 600_000);

	test("the fallback wheel on a supported platform (glibc on Linux) names the real causes (OS, glibc, pip version), and names the platform wheel", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		// [sys.platform, platform.machine(), libc, npm name, the wheel's tag]
		const cases: [string, string, string, string, string][] = [
			["linux", "x86_64", "glibc", "linux-x64", "manylinux_2_17_x86_64"],
			["linux", "aarch64", "glibc", "linux-arm64", "manylinux_2_17_aarch64"],
			["darwin", "arm64", "unknown", "darwin-arm64", "macosx_11_0_arm64"],
			["darwin", "x86_64", "unknown", "darwin-x64", "macosx_10_12_x86_64"],
			["win32", "AMD64", "unknown", "win32-x64", "win_amd64"],
		];
		for (const [systemPlatform, machine, libc, name, platformTag] of cases)
			expect({
				systemPlatform,
				machine,
				message: await pythonMessage(
					paths.python,
					work,
					systemPlatform,
					machine,
					libc,
					true,
				),
			}).toEqual({
				systemPlatform,
				machine,
				message: fallbackWheelChosenMessage(name, platformTag),
			});
	}, 600_000);

	test("the plain message stays where it is true: no platform wheel, a C library that cannot be told, or a platform wheel missing its binary", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		// [sys.platform, platform.machine(), libc, fallback, npm name]
		const cases: [string, string, string, boolean, string][] = [
			["linux", "riscv64", "glibc", true, "linux-riscv64"],
			["win32", "ARM64", "unknown", true, "win32-arm64"],
			["linux", "x86_64", "unknown", true, "linux-x64"],
			["linux", "x86_64", "glibc", false, "linux-x64"],
			["darwin", "arm64", "unknown", false, "darwin-arm64"],
		];
		for (const [systemPlatform, machine, libc, fallback, name] of cases)
			expect({
				systemPlatform,
				machine,
				libc,
				fallback,
				message: await pythonMessage(
					paths.python,
					work,
					systemPlatform,
					machine,
					libc,
					fallback,
				),
			}).toEqual({
				systemPlatform,
				machine,
				libc,
				fallback,
				message: `llm-tests-forge has no binary for ${name}; see https://github.com/albertosca/llm-tests-forge for install.sh`,
			});
	}, 600_000);

	test("on musl Linux, fallback or not, the message says musl has no binary yet instead of naming linux-x64 unsupported", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		for (const [machine, name, fallback] of [
			["x86_64", "linux-x64", true],
			["aarch64", "linux-arm64", true],
			["x86_64", "linux-x64", false],
		] as const)
			expect(
				await pythonMessage(
					paths.python,
					work,
					"linux",
					machine,
					"musl",
					fallback,
				),
			).toBe(muslMessage(name));
	}, 600_000);

	test("the C library is glibc when libc_ver says so, musl when it says musl or a musl loader exists, and unknown otherwise", async () => {
		const paths = await installedVenv();
		const { work } = await builtWheels();
		// [platform.libc_ver()[0], the /lib/ld-musl-* paths found, the family]
		const cases: [string, string[], string][] = [
			["glibc", [], "glibc"],
			["glibc", ["/lib/ld-musl-x86_64.so.1"], "glibc"],
			["musl", [], "musl"],
			["", ["/lib/ld-musl-aarch64.so.1"], "musl"],
			["", [], "unknown"],
		];
		for (const [libcName, loaders, family] of cases)
			expect({
				libcName,
				loaders,
				family: (
					await mustRun(
						[
							paths.python,
							"-c",
							"import json, sys, llm_tests_forge; print(llm_tests_forge.libc_family(sys.argv[1], json.loads(sys.argv[2])))",
							libcName,
							JSON.stringify(loaders),
						],
						work,
					)
				).trim(),
			}).toEqual({ libcName, loaders, family });
	}, 600_000);

	test("the fallback wheel is pure Python with the stamped version: Root-Is-Purelib true, no binary inside, the LICENSE inside", async () => {
		const { work, fallbackWheel } = await builtWheels();
		const paths = await installedVenv();
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
						"metadata = next(name for name in names if name.endswith('.dist-info/METADATA'))",
						"version = next(line for line in archive.read(metadata).decode().splitlines() if line.startswith('Version: '))",
						"print(json.dumps({'wheel': archive.read(wheel).decode(), 'version': version, 'binaries': [name for name in names if '/bin/' in name], 'license': archive.read('llm_tests_forge/LICENSE').decode() if 'llm_tests_forge/LICENSE' in names else None}))",
					].join("\n"),
					fallbackWheel,
				],
				work,
			),
		);
		expect(inspected.wheel.split("\n")).toContain("Root-Is-Purelib: true");
		expect(inspected.wheel.split("\n")).toContain("Tag: py3-none-any");
		expect(inspected.version).toBe(`Version: ${FORGE_VERSION}`);
		expect(inspected.binaries).toEqual([]);
		expect(inspected.license).toBe(
			await Bun.file(join(REPOSITORY, "LICENSE")).text(),
		);
	}, 600_000);

	test("for each platform uv can install for, an index of every target's wheel and the fallback resolves to that platform's wheel, and to the fallback where no target fits", async () => {
		const work = await mkdtemp(join(tmpdir(), "forge-pypi-platforms-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await mkdir(binaries);
		for (const target of RELEASE_TARGETS)
			await writeFile(join(binaries, target.assetName), "a stand-in binary\n");
		const index = join(work, "index");
		await renderWheels(binaries, index, REPOSITORY, "uv");
		await renderFallbackWheel(index, REPOSITORY, "uv");
		const venv = join(work, "venv");
		await mustRun(["uv", "venv", venv], work);
		// [uv's --python-platform, the platform tag (compressed, as in the wheel's file name) of the wheel it must choose]
		const cases: [string, string][] = [
			["aarch64-apple-darwin", "macosx_11_0_arm64"],
			["x86_64-apple-darwin", "macosx_10_12_x86_64"],
			[
				"x86_64-unknown-linux-gnu",
				"manylinux_2_17_x86_64.manylinux2014_x86_64",
			],
			[
				"aarch64-unknown-linux-gnu",
				"manylinux_2_17_aarch64.manylinux2014_aarch64",
			],
			["x86_64-pc-windows-msvc", "win_amd64"],
			["x86_64-unknown-linux-musl", "any"],
			["aarch64-unknown-linux-musl", "any"],
			["aarch64-pc-windows-msvc", "any"],
			["i686-pc-windows-msvc", "any"],
		];
		for (const [pythonPlatform, platformTag] of cases) {
			const target = join(work, `target-${pythonPlatform}`);
			await mustRun(
				[
					"uv",
					"pip",
					"install",
					"--offline",
					"--no-index",
					"--find-links",
					index,
					"--python",
					venvPaths(venv).python,
					"--python-platform",
					pythonPlatform,
					"--target",
					target,
					REQUIREMENT,
				],
				work,
			);
			const wheelText = await Bun.file(
				join(
					target,
					`llm_tests_forge-${pep440Version(FORGE_VERSION)}.dist-info/WHEEL`,
				),
			).text();
			const chosen = wheelText
				.split("\n")
				.filter((line) => line.startsWith("Tag: "))
				.sort();
			expect({ pythonPlatform, chosen }).toEqual({
				pythonPlatform,
				chosen: platformTag
					.split(".")
					.map((single) => `Tag: py3-none-${single}`)
					.sort(),
			});
		}
	}, 600_000);

	test("the build refuses a binary for the platform any, since the fallback ships none", async () => {
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
				FORGE_WHEEL_PLATFORM: "any",
				FORGE_WHEEL_BINARY: join(work, "binaries", "llm-tests-forge"),
			},
		);
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(
			"FORGE_WHEEL_BINARY is set, but the any wheel is the fallback and ships no binary",
		);
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
