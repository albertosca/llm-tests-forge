/**
 * The RubyGems gems, end to end: the host binary compiled, the gems built
 * from it by `gem build`, and the host gem installed into a temporary
 * `--install-dir`, where the shim must run the binary; a gem for another
 * platform must not run its binary, and the gemspec must refuse to build
 * without its two variables. Off by default; run with `bun run
 * test:packages` (sets FORGE_PACKAGES=1). It needs ruby and gem on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { gemFileName, renderGems } from "../../scripts/release/gems";
import {
	RELEASE_TARGETS,
	type ReleaseTarget,
} from "../../scripts/release/targets";
import { GEM_MANIFESTS, stampVersion } from "../../scripts/release/version";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const LIBRARY = join(REPOSITORY, "packages/gem/lib/llm_tests_forge.rb");
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform && target.npmCpu === process.arch,
);
// A target whose gem this machine's RubyGems must not run: Windows from anywhere else, Linux from Windows.
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
	hostGem: string;
	foreignGem: string;
	binaries: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host and the foreign gem, built once for all the tests; the foreign one carries the host binary under its own name. */
function builtGems(): Promise<Built> {
	builtOnce ??= (async () => {
		if (HOST === undefined || FOREIGN === undefined)
			throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-gem-e2e-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await buildBinaries(binaries, HOST.bunTarget);
		await Bun.write(
			join(binaries, FOREIGN.assetName),
			Bun.file(join(binaries, HOST.assetName)),
		);
		const [hostGem, foreignGem] = await renderGems(
			binaries,
			join(work, "gems"),
			REPOSITORY,
			"gem",
			[HOST, FOREIGN],
		);
		if (hostGem === undefined || foreignGem === undefined)
			throw new Error("gem build wrote no gem");
		return { work, hostGem, foreignGem, binaries };
	})();
	return builtOnce;
}

interface Installed {
	home: string;
	entry: string;
	environment: Record<string, string | undefined>;
}

/** A fresh install directory under the shared work directory holding `gem`, installed the way a user's `gem install` would. */
async function installed(gem: string): Promise<Installed> {
	const { work } = await builtGems();
	const home = await mkdtemp(join(work, "home-"));
	await mustRun(
		[
			"gem",
			"install",
			"--local",
			"--ignore-dependencies",
			"--install-dir",
			home,
			"--bindir",
			join(home, "bin"),
			gem,
		],
		work,
	);
	return {
		home,
		entry: join(
			home,
			"bin",
			process.platform === "win32" ? "llm-tests-forge.bat" : "llm-tests-forge",
		),
		environment: { ...process.env, GEM_HOME: home, GEM_PATH: home },
	};
}

/** The directory of the installed gem that holds `exe/` and `lib/`. */
async function installedGemDirectory(home: string): Promise<string> {
	const listing = await mustRun(
		[
			"ruby",
			"-e",
			'puts Dir.glob(File.join(ARGV.fetch(0), "gems", "llm-tests-forge-*")).first',
			home,
		],
		home,
	);
	return listing.trim();
}

/** This machine as the npm package names it (darwin-arm64, linux-x64, win32-x64): the name every package's message uses. */
const NPM_PLATFORM_NAME = `${process.platform}-${process.arch}`;

async function rubyOutput(
	program: string,
	directory: string,
): Promise<Finished> {
	return run(
		["ruby", "-e", `require ${JSON.stringify(LIBRARY)}\n${program}`],
		directory,
	);
}

function nameOf(target: ReleaseTarget): string {
	return target.gemPlatform;
}

describe.skipIf(!packages)("rubygems gems", () => {
	test("the host gem installed into a temporary install directory runs the binary through the shim", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, work } = await builtGems();
		const { entry, environment } = await installed(hostGem);
		expect(await run([entry, "--version"], work, environment)).toEqual({
			exitCode: 0,
			stdout: `${FORGE_VERSION}\n`,
			stderr: "",
		});
	}, 600_000);

	test("the installed gem carries its binary, executable, under exe/<platform>/", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, work } = await builtGems();
		const { home } = await installed(hostGem);
		const gemDirectory = await installedGemDirectory(home);
		const binaryName =
			process.platform === "win32" ? "llm-tests-forge.exe" : "llm-tests-forge";
		const listing = await mustRun(
			[
				"ruby",
				"-e",
				'path = File.join(ARGV.fetch(0), "exe", ARGV.fetch(1), ARGV.fetch(2)); print File.file?(path), " ", File.executable?(path)',
				gemDirectory,
				nameOf(HOST),
				binaryName,
			],
			work,
		);
		expect(listing).toBe("true true");
	}, 600_000);

	test.skipIf(process.platform === "win32")(
		"the binstub RubyGems generates ends up as the binary itself: same process, and the binary's exit status comes through",
		async () => {
			if (HOST === undefined) throw new Error("this machine is not a target");
			const { hostGem, work } = await builtGems();
			const { home, entry, environment } = await installed(hostGem);
			const binary = join(
				await installedGemDirectory(home),
				"exe",
				nameOf(HOST),
				"llm-tests-forge",
			);
			await writeFile(binary, '#!/bin/sh\necho "pid $$ args $*"\nexit 7\n');
			await chmod(binary, 0o755);
			const child = Bun.spawn([entry, "one", "two"], {
				cwd: work,
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stdout, stderr }).toEqual({
				exitCode: 7,
				stdout: `pid ${child.pid} args one two\n`,
				stderr: "",
			});
		},
		600_000,
	);

	test("the installed gem carries the repository's LICENSE", async () => {
		const { hostGem } = await builtGems();
		const { home } = await installed(hostGem);
		const gemDirectory = await installedGemDirectory(home);
		expect(await Bun.file(join(gemDirectory, "LICENSE")).text()).toBe(
			await Bun.file(join(REPOSITORY, "LICENSE")).text(),
		);
	}, 600_000);

	test("a gem for another platform never runs its binary: RubyGems refuses its executable, and the shim run directly names this platform and the install script and exits 1", async () => {
		const { foreignGem, work } = await builtGems();
		const { home, entry, environment } = await installed(foreignGem);
		const refused = await run([entry, "--version"], work, environment);
		expect(refused.exitCode).not.toBe(0);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain("can't find gem llm-tests-forge");
		const shim = join(await installedGemDirectory(home), "exe/llm-tests-forge");
		expect(await run(["ruby", shim, "--version"], work, environment)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `llm-tests-forge has no binary for ${NPM_PLATFORM_NAME}; see https://github.com/albertosca/llm-tests-forge for install.sh\n`,
		});
	}, 600_000);

	test("with the binary removed from the installed gem, the shim names the platform and the install script and exits 1", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, work } = await builtGems();
		const { home, entry, environment } = await installed(hostGem);
		const gemDirectory = await installedGemDirectory(home);
		await rm(join(gemDirectory, "exe", nameOf(HOST)), { recursive: true });
		expect(await run([entry, "--version"], work, environment)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `llm-tests-forge has no binary for ${NPM_PLATFORM_NAME}; see https://github.com/albertosca/llm-tests-forge for install.sh\n`,
		});
	}, 600_000);

	test("a prerelease version (0.1.0-rc.1) is built by real gem into a gem RubyGems reads as 0.1.0.pre.rc.1", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-gem-prerelease-"));
		workDirectories.push(work);
		const root = join(work, "root");
		await cp(join(REPOSITORY, "packages/gem"), join(root, "packages/gem"), {
			recursive: true,
		});
		await writeFile(
			join(root, "package.json"),
			'{ "version": "0.1.0-rc.1" }\n',
		);
		await cp(join(REPOSITORY, "LICENSE"), join(root, "LICENSE"));
		await stampVersion(root, GEM_MANIFESTS);
		const binaries = join(work, "binaries");
		await mkdir(binaries);
		await writeFile(join(binaries, HOST.assetName), "a stand-in binary\n");
		const [gem] = await renderGems(binaries, join(work, "gems"), root, "gem", [
			HOST,
		]);
		expect(gem).toBe(join(work, "gems", gemFileName("0.1.0-rc.1", HOST)));
		expect(
			(
				await mustRun(
					[
						"ruby",
						"-e",
						'require "rubygems/package"; print Gem::Package.new(ARGV.fetch(0)).spec.version',
						gem ?? "",
					],
					work,
				)
			).trim(),
		).toBe("0.1.0.pre.rc.1");
	}, 600_000);

	test("the gemspec refuses to build without the platform variable, then without the binary variable, naming each", async () => {
		const { work, binaries } = await builtGems();
		const environment: Record<string, string | undefined> = {
			...process.env,
		};
		delete environment.FORGE_GEM_PLATFORM;
		delete environment.FORGE_GEM_BINARY;
		const spec = join(REPOSITORY, "packages/gem/llm-tests-forge.gemspec");
		const missingPlatform = await run(
			["gem", "build", spec, "--output", join(work, "refused.gem")],
			work,
			{ ...environment, FORGE_GEM_BINARY: join(binaries, "unused") },
		);
		expect(missingPlatform.exitCode).not.toBe(0);
		expect(missingPlatform.stderr).toContain("FORGE_GEM_PLATFORM is not set");
		const missingBinary = await run(
			["gem", "build", spec, "--output", join(work, "refused.gem")],
			work,
			{ ...environment, FORGE_GEM_PLATFORM: "arm64-darwin" },
		);
		expect(missingBinary.exitCode).not.toBe(0);
		expect(missingBinary.stderr).toContain("FORGE_GEM_BINARY is not set");
	}, 600_000);

	test("the platform directory is matched by RubyGems' own rules, for every target against the local platform names RubyGems reports", async () => {
		const { work } = await builtGems();
		const layout = await mkdtemp(join(work, "layout-"));
		for (const target of RELEASE_TARGETS) {
			const name = nameOf(target);
			await mkdir(join(layout, name));
			await writeFile(
				join(layout, name, "llm-tests-forge"),
				`#!/bin/sh\n# ${name}\n`,
			);
		}
		// [local platform as RubyGems reports it, the directory that must be chosen]
		const cases: [string, string | null][] = [
			["arm64-darwin-25", "arm64-darwin"],
			["x86_64-darwin-23", "x86_64-darwin"],
			["x86_64-linux", "x86_64-linux-gnu"],
			["aarch64-linux", "aarch64-linux-gnu"],
			["x86_64-linux-musl", null],
			["x86-linux", null],
			["arm-linux", null],
			["x86_64-freebsd", null],
		];
		for (const [local, chosen] of cases) {
			const finished = await rubyOutput(
				`path = LlmTestsForge.binary_path(executables_directory: ${JSON.stringify(layout)}, local_platform: Gem::Platform.new(${JSON.stringify(local)}), windows: false)\nprint path.nil? ? "none" : File.basename(File.dirname(path))`,
				work,
			);
			expect({ local, ...finished }).toEqual({
				local,
				exitCode: 0,
				stdout: chosen ?? "none",
				stderr: "",
			});
		}
		const windows = await rubyOutput(
			`path = LlmTestsForge.binary_path(executables_directory: ${JSON.stringify(layout)}, local_platform: Gem::Platform.new("x64-mingw-ucrt"), windows: true)\nprint path.nil? ? "none" : File.basename(File.dirname(path))`,
			work,
		);
		// The layout holds no .exe, so the Windows lookup finds nothing rather than a Unix binary.
		expect(windows.stdout).toBe("none");
	}, 600_000);

	test("the unsupported message names the platform the way the npm package does, for every platform RubyGems reports", async () => {
		const { work } = await builtGems();
		// [local platform as RubyGems reports it, the name in the message]
		const cases: [string, string][] = [
			["arm64-darwin-25", "darwin-arm64"],
			["x86_64-darwin-23", "darwin-x64"],
			["x86_64-linux", "linux-x64"],
			["aarch64-linux", "linux-arm64"],
			["x64-mingw-ucrt", "win32-x64"],
			["x86_64-freebsd", "freebsd-x64"],
			["x86-linux", "linux-x86"],
		];
		for (const [local, name] of cases) {
			const finished = await rubyOutput(
				`print LlmTestsForge.missing_binary_message(local_platform: Gem::Platform.new(${JSON.stringify(local)}))`,
				work,
			);
			expect({ local, ...finished }).toEqual({
				local,
				exitCode: 0,
				stdout: `llm-tests-forge has no binary for ${name}; see https://github.com/albertosca/llm-tests-forge for install.sh`,
				stderr: "",
			});
		}
	}, 600_000);

	test("the shim replaces itself with the binary, so the binary's own exit status comes through", async () => {
		if (process.platform === "win32") return;
		const { work } = await builtGems();
		const layout = await mkdtemp(join(work, "layout-"));
		const directoryName = (
			await mustRun(["ruby", "-e", "print Gem::Platform.local.to_s"], work)
		).trim();
		await mkdir(join(layout, directoryName));
		const binary = join(layout, directoryName, "llm-tests-forge");
		await writeFile(binary, '#!/bin/sh\necho "args: $*"\nexit 7\n');
		await chmod(binary, 0o755);
		expect(
			await rubyOutput(
				`LlmTestsForge.run(["one", "two"], executables_directory: ${JSON.stringify(layout)})`,
				work,
			),
		).toEqual({ exitCode: 7, stdout: "args: one two\n", stderr: "" });
	}, 600_000);
});

const INTERRUPT_COUNTING_CHILD = `#!/usr/bin/env ruby
count = 0
Signal.trap("INT") do
  count += 1
  puts "interrupt #{count}"
  $stdout.flush
  exit!(130) if count == 2
end
puts "ready"
$stdout.flush
sleep
`;

const SELF_TERMINATING_CHILD = `#!/usr/bin/env ruby
Process.kill("TERM", Process.pid)
sleep 30
`;

/** The Windows path of the shim (run_attached), started as its own process group leader the way a terminal's foreground job is. */
async function startAttached(childSource: string) {
	const { work } = await builtGems();
	const childPath = join(
		work,
		`child-${Math.random().toString(36).slice(2)}.rb`,
	);
	await writeFile(childPath, childSource, { mode: 0o755 });
	const launcher = spawn(
		"ruby",
		[
			"-e",
			`require ${JSON.stringify(LIBRARY)}\nexit LlmTestsForge.run_attached(ARGV.fetch(0), [])`,
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
	"the attached runner used where exec does not keep the shim out of the way",
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
