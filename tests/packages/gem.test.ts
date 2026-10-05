/**
 * The RubyGems gems, end to end: the host binary compiled, the gems built
 * from it by `gem build`, and the host gem installed into a temporary
 * `--install-dir`, where the shim must run the binary; a gem for another
 * platform must not run its binary, and the gemspec must refuse to build
 * without its two variables. The `ruby`-platform fallback gem must lose to
 * the platform gem wherever one fits, and name the platform where none
 * does. Off by default; run with `bun run
 * test:packages` (sets FORGE_PACKAGES=1). It needs ruby and gem on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildBinaries } from "../../scripts/release/build-binaries";
import {
	gemFileName,
	renderFallbackGem,
	renderGems,
} from "../../scripts/release/gems";
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
	fallbackGem: string;
	binaries: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host, the foreign and the fallback gem, built once for all the tests; the foreign one carries the host binary under its own name. */
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
		const fallbackGem = await renderFallbackGem(
			join(work, "fallbacks"),
			REPOSITORY,
			"gem",
		);
		return { work, hostGem, foreignGem, fallbackGem, binaries };
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

/**
 * Writes the legacy RubyGems index (specs.4.8.gz, latest_specs.4.8.gz,
 * prerelease_specs.4.8.gz and quick/Marshal.4.8/) for the gems under
 * `<ARGV[0]>/gems`: what `gem install --source` reads, so the install goes
 * through the resolver that chooses among rubygems.org's gems. The fallback
 * is listed first when ARGV[1] is "fallback-first" and last otherwise, so a
 * test that runs both orders cannot pass on the index's order.
 */
const WRITE_GEM_INDEX = `
require "rubygems/package"
require "fileutils"
Dir.chdir(ARGV.fetch(0)) do
  specifications = Dir["gems/*.gem"].sort.map { |file| Gem::Package.new(file).spec }
  fallbacks, platforms = specifications.partition { |specification| specification.platform == Gem::Platform::RUBY }
  ordered = ARGV.fetch(1) == "fallback-first" ? fallbacks + platforms : platforms + fallbacks
  tuples = ordered.map { |specification| [specification.name, specification.version, specification.original_platform] }
  File.binwrite("specs.4.8.gz", Gem::Util.gzip(Marshal.dump(tuples)))
  File.binwrite("latest_specs.4.8.gz", Gem::Util.gzip(Marshal.dump(tuples)))
  File.binwrite("prerelease_specs.4.8.gz", Gem::Util.gzip(Marshal.dump([])))
  FileUtils.mkdir_p("quick/Marshal.4.8")
  ordered.each do |specification|
    File.binwrite("quick/Marshal.4.8/#{specification.full_name}.gemspec.rz", Gem.deflate(Marshal.dump(specification)))
  end
end
`;

type IndexOrder = "fallback-first" | "fallback-last";

/**
 * A gem repository holding copies of `gems` and their index, served by
 * file://. Not `gem install --local` from a directory: that takes the first
 * gem of the highest version it reads from the directory, whatever its
 * platform, so it answers by file order (measured: renaming the fallback to
 * sort first made it install the fallback beside the host gem).
 */
async function gemRepository(
	gems: string[],
	order: IndexOrder,
): Promise<string> {
	const { work } = await builtGems();
	const repository = await mkdtemp(join(work, "repository-"));
	await mkdir(join(repository, "gems"));
	for (const gem of gems)
		await cp(gem, join(repository, "gems", basename(gem)));
	await mustRun(["ruby", "-e", WRITE_GEM_INDEX, repository, order], work);
	return repository;
}

/**
 * llm-tests-forge installed by name from `repository` alone, so RubyGems'
 * resolver chooses the gem, as `gem install llm-tests-forge` does against
 * rubygems.org; `platform`, when given, stands for the local platform
 * (`--platform`).
 */
async function installedFrom(
	repository: string,
	platform?: string,
): Promise<Installed> {
	const home = await mkdtemp(join(repository, "..", "home-"));
	const installation = await run(
		[
			"gem",
			"install",
			"--no-document",
			"--clear-sources",
			"--source",
			`${pathToFileURL(repository).href}/`,
			"--ignore-dependencies",
			"--install-dir",
			home,
			"--bindir",
			join(home, "bin"),
			...(platform === undefined ? [] : ["--platform", platform]),
			"llm-tests-forge",
		],
		home,
		{ ...process.env, GEM_SPEC_CACHE: join(home, "spec-cache") },
	);
	if (installation.exitCode !== 0)
		throw new Error(
			`gem install exited ${installation.exitCode}: ${installation.stderr}`,
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

/** The platform of each llm-tests-forge spec installed under `home`: the gem RubyGems chose. */
async function installedPlatforms(home: string): Promise<string> {
	return mustRun(
		[
			"ruby",
			"-e",
			'print Dir.glob(File.join(ARGV.fetch(0), "specifications", "llm-tests-forge-*.gemspec")).map { |path| Gem::Specification.load(path).platform.to_s }.sort.join(",")',
			home,
		],
		home,
	);
}

const UNSUPPORTED_MESSAGE = `llm-tests-forge has no binary for ${NPM_PLATFORM_NAME}; see https://github.com/albertosca/llm-tests-forge for install.sh\n`;

describe.skipIf(!packages)("the fallback gem", () => {
	test("with the host gem and the fallback in one repository, in either index order, gem install by name installs the host gem, and the shim runs the binary", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, fallbackGem, work } = await builtGems();
		for (const order of ["fallback-first", "fallback-last"] as const) {
			const { home, entry, environment } = await installedFrom(
				await gemRepository([fallbackGem, hostGem], order),
			);
			expect({ order, installed: await installedPlatforms(home) }).toEqual({
				order,
				installed: HOST.gemPlatform,
			});
			expect(await run([entry, "--version"], work, environment)).toEqual({
				exitCode: 0,
				stdout: `${FORGE_VERSION}\n`,
				stderr: "",
			});
		}
	}, 600_000);

	test("with only the fallback in the repository, gem install by name installs it, and the shim names this platform and install.sh and exits 1", async () => {
		const { fallbackGem, work } = await builtGems();
		const { home, entry, environment } = await installedFrom(
			await gemRepository([fallbackGem], "fallback-last"),
		);
		expect(await installedPlatforms(home)).toBe("ruby");
		expect(await run([entry, "--version"], work, environment)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: UNSUPPORTED_MESSAGE,
		});
	}, 600_000);

	test("the fallback gem is a ruby-platform gem with the stamped version, the shim, the library and the LICENSE, and no binary", async () => {
		const { fallbackGem, work } = await builtGems();
		const inspected = JSON.parse(
			await mustRun(
				[
					"ruby",
					"-rjson",
					"-e",
					'require "rubygems/package"; spec = Gem::Package.new(ARGV.fetch(0)).spec; print JSON.generate(platform: spec.platform.to_s, version: spec.version.to_s, files: spec.files.sort, executables: spec.executables)',
					fallbackGem,
				],
				work,
			),
		);
		expect(inspected).toEqual({
			platform: "ruby",
			version: FORGE_VERSION,
			files: ["LICENSE", "exe/llm-tests-forge", "lib/llm_tests_forge.rb"],
			executables: ["llm-tests-forge"],
		});
	}, 600_000);

	test("for each platform RubyGems is told it runs on, a repository of every target's gem and the fallback, in either index order, installs that platform's gem, and the fallback where no target fits", async () => {
		const work = await mkdtemp(join(tmpdir(), "forge-gem-platforms-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await mkdir(binaries);
		for (const target of RELEASE_TARGETS)
			await writeFile(join(binaries, target.assetName), "a stand-in binary\n");
		const gems = [
			...(await renderGems(binaries, join(work, "gems"), REPOSITORY, "gem")),
			await renderFallbackGem(join(work, "gems"), REPOSITORY, "gem"),
		];
		// [the platform given to --platform, the platform of the gem it must install]
		const cases: [string, string][] = [
			["arm64-darwin-25", "arm64-darwin"],
			["x86_64-darwin-23", "x86_64-darwin"],
			["x86_64-linux", "x86_64-linux-gnu"],
			["aarch64-linux", "aarch64-linux-gnu"],
			["x64-mingw-ucrt", "x64-mingw-ucrt"],
			["x86_64-linux-musl", "ruby"],
			["aarch64-linux-musl", "ruby"],
			["x86_64-freebsd", "ruby"],
			["arm-linux", "ruby"],
		];
		for (const order of ["fallback-first", "fallback-last"] as const) {
			const repository = await gemRepository(gems, order);
			for (const [platform, chosen] of cases) {
				const { home } = await installedFrom(repository, platform);
				expect({
					order,
					platform,
					installed: await installedPlatforms(home),
				}).toEqual({ order, platform, installed: chosen });
			}
		}
	}, 600_000);

	test("the gemspec refuses a binary for the platform ruby, since the fallback ships none", async () => {
		const { work, binaries } = await builtGems();
		const finished = await run(
			[
				"gem",
				"build",
				join(REPOSITORY, "packages/gem/llm-tests-forge.gemspec"),
				"--output",
				join(work, "refused.gem"),
			],
			work,
			{
				...process.env,
				FORGE_GEM_PLATFORM: "ruby",
				FORGE_GEM_BINARY: join(binaries, "unused"),
			},
		);
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(
			"FORGE_GEM_BINARY is set, but the ruby gem is the fallback and ships no binary",
		);
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
