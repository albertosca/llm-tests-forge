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
import { muslMessage } from "../helpers/platform-messages";

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
			["x64-mingw32", "win32-x64"],
			["x86-mingw32", "win32-ia32"],
			["x86_64-freebsd", "freebsd-x64"],
			// RubyGems spells every 32-bit x86 (i386 to i686) as x86; npm says ia32.
			["x86-linux", "linux-ia32"],
			["i686-linux", "linux-ia32"],
		];
		for (const [local, name] of cases) {
			const finished = await rubyOutput(
				`print LlmTestsForge.missing_binary_message(local_platform: Gem::Platform.new(${JSON.stringify(local)}), installed_gem_platform: nil)`,
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
 *
 * As rubygems.org does, each gem is served as gems/<full_name>.gem (a
 * prerelease's full name spells the version 0.1.0.pre.rc.2, not the
 * 0.1.0-rc.2 of its build file name), and a prerelease is listed in
 * prerelease_specs only, never in specs or latest_specs.
 */
const WRITE_GEM_INDEX = `
require "rubygems/package"
require "fileutils"
Dir.chdir(ARGV.fetch(0)) do
  specifications = Dir["gems/*.gem"].sort.map do |file|
    specification = Gem::Package.new(file).spec
    served = "gems/#{specification.full_name}.gem"
    File.rename(file, served) unless file == served
    specification
  end
  fallbacks, platforms = specifications.partition { |specification| specification.platform == Gem::Platform::RUBY }
  ordered = ARGV.fetch(1) == "fallback-first" ? fallbacks + platforms : platforms + fallbacks
  tuple = ->(specification) { [specification.name, specification.version, specification.original_platform] }
  prereleases, releases = ordered.partition { |specification| specification.version.prerelease? }
  File.binwrite("specs.4.8.gz", Gem::Util.gzip(Marshal.dump(releases.map(&tuple))))
  File.binwrite("latest_specs.4.8.gz", Gem::Util.gzip(Marshal.dump(releases.map(&tuple))))
  File.binwrite("prerelease_specs.4.8.gz", Gem::Util.gzip(Marshal.dump(prereleases.map(&tuple))))
  FileUtils.mkdir_p("quick/Marshal.4.8")
  ordered.each do |specification|
    File.binwrite("quick/Marshal.4.8/#{specification.full_name}.gemspec.rz", Gem.deflate(Marshal.dump(specification)))
  end
end
`;

/**
 * package.json's version as RubyGems spells it, by RubyGems' own rule (each
 * "-" becomes ".pre."): 0.1.0-rc.2 is 0.1.0.pre.rc.2, 0.1.0 stays 0.1.0.
 */
const GEM_VERSION = FORGE_VERSION.replaceAll("-", ".pre.");

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
 * (`--platform`). `--pre` lets the name match a prerelease, which is all a
 * prerelease-stamped repository holds; a release resolves the same with it.
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
			"--pre",
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

/**
 * A Bundler project depending on llm-tests-forge from `source`, with every
 * Bundler path kept inside it: `bundle install`, then `bundle exec
 * llm-tests-forge --version`, whose result is returned. `lockfile` is written
 * as Gemfile.lock first; `configuration` holds BUNDLE_* settings.
 */
async function bundledProject(
	work: string,
	source: string,
	options: {
		lockfile?: string;
		configuration?: Record<string, string>;
		gemOptions?: string;
	},
): Promise<Finished> {
	const project = await mkdtemp(join(work, "bundled-"));
	// The exact version, so Bundler takes a prerelease (it skips one for a
	// bare name) and the lockfile's DEPENDENCIES line below matches.
	await writeFile(
		join(project, "Gemfile"),
		`source ${JSON.stringify(source)}\ngem "llm-tests-forge", "= ${GEM_VERSION}"${options.gemOptions ?? ""}\n`,
	);
	if (options.lockfile !== undefined)
		await writeFile(join(project, "Gemfile.lock"), options.lockfile);
	const environment = {
		...process.env,
		BUNDLE_GEMFILE: join(project, "Gemfile"),
		BUNDLE_PATH: join(project, "vendor"),
		BUNDLE_APP_CONFIG: join(project, ".bundle"),
		BUNDLE_USER_HOME: join(project, "bundle-home"),
		GEM_SPEC_CACHE: join(project, "spec-cache"),
		...options.configuration,
	};
	const installation = await run(
		["bundle", "install", "--quiet"],
		project,
		environment,
	);
	if (installation.exitCode !== 0)
		throw new Error(
			`bundle install exited ${installation.exitCode}: ${installation.stdout}${installation.stderr}`,
		);
	return run(
		["bundle", "exec", "llm-tests-forge", "--version"],
		project,
		environment,
	);
}

/** What chose the fallback gem on a platform that has a native gem: Bundler's force_ruby_platform, a Gemfile.lock whose PLATFORMS lacks this platform, or gem install outside Bundler. */
type FallbackCause = "force_ruby_platform" | "lockfile" | "gem_install";

/** What the fallback gem says on a platform that has a native gem (`name` in npm's spelling, `native` the native gem's platform), for each cause. */
function fallbackGemChosenMessage(
	name: string,
	native: string,
	cause: FallbackCause,
): string {
	const opening = `llm-tests-forge: this is the ruby-platform fallback gem, which has no binary, but ${name} has a native gem (${native}); `;
	const causes: Record<FallbackCause, string> = {
		force_ruby_platform:
			"Bundler's force_ruby_platform chose the fallback. Unset it (bundle config unset force_ruby_platform, or drop force_ruby_platform: true from the Gemfile) and run bundle install",
		lockfile: `Bundler chose the fallback because the PLATFORMS of Gemfile.lock lack this platform. Add it: bundle lock --add-platform ${native}, then bundle install`,
		gem_install:
			"gem install --platform ruby chose the fallback (if Bundler installed it, run it with bundle exec to see why). Reinstall it without --platform ruby: gem install llm-tests-forge",
	};
	// Only the glibc Linux gems carry a -gnu platform, which RubyGems before 3.3.21 does not match to the local x86_64-linux.
	const oldRubyGems = native.endsWith("-gnu")
		? `. If none of that applies, RubyGems older than 3.3.21 may not match the glibc gem (${native}) to this platform: gem update --system, then reinstall`
		: "";
	return `${opening}${causes[cause]}${oldRubyGems}`;
}

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

	// This machine has a native gem, so the installed fallback says so; the
	// plain message for a platform without one is pinned by the message tests.
	test("with only the fallback in the repository, gem install by name installs it, and its shim exits 1 naming the native gem this platform has", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { fallbackGem, work } = await builtGems();
		const { home, entry, environment } = await installedFrom(
			await gemRepository([fallbackGem], "fallback-last"),
		);
		expect(await installedPlatforms(home)).toBe("ruby");
		expect(await run([entry, "--version"], work, environment)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${fallbackGemChosenMessage(NPM_PLATFORM_NAME, HOST.gemPlatform, "gem_install")}\n`,
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
			version: GEM_VERSION,
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

	test("the shim's list of native gem platforms is the release targets' (scripts/release/targets.ts), in order", async () => {
		const { work } = await builtGems();
		const finished = await rubyOutput(
			'require "json"\nprint JSON.generate(LlmTestsForge::RELEASE_GEM_PLATFORMS)',
			work,
		);
		expect(finished.exitCode).toBe(0);
		expect(JSON.parse(finished.stdout)).toEqual(
			RELEASE_TARGETS.map((target) => target.gemPlatform),
		);
	}, 600_000);

	test("the fallback gem on a platform that has a native gem names the native gem, what chose the fallback, and the fix for that cause", async () => {
		const { work } = await builtGems();
		// [local platform as RubyGems reports it, the npm name, the native gem's platform]
		const cases: [string, string, string][] = [
			["arm64-darwin-25", "darwin-arm64", "arm64-darwin"],
			["x86_64-darwin-23", "darwin-x64", "x86_64-darwin"],
			["x86_64-linux", "linux-x64", "x86_64-linux-gnu"],
			["aarch64-linux", "linux-arm64", "aarch64-linux-gnu"],
			["x64-mingw-ucrt", "win32-x64", "x64-mingw-ucrt"],
		];
		for (const cause of [
			"force_ruby_platform",
			"lockfile",
			"gem_install",
		] as const)
			for (const [local, name, native] of cases) {
				const finished = await rubyOutput(
					`print LlmTestsForge.missing_binary_message(local_platform: Gem::Platform.new(${JSON.stringify(local)}), installed_gem_platform: "ruby", fallback_cause: :${cause})`,
					work,
				);
				expect({ local, cause, ...finished }).toEqual({
					local,
					cause,
					exitCode: 0,
					stdout: fallbackGemChosenMessage(name, native, cause),
					stderr: "",
				});
			}
	}, 600_000);

	test("the cause is read from Bundler when it is loaded: force_ruby_platform set globally or for this gem in the Gemfile, otherwise the lockfile; without Bundler, gem install", async () => {
		const { work } = await builtGems();
		// A stand-in for the Bundler module: its settings, and the Gemfile's
		// llm-tests-forge dependency (nil when the Gemfile has none, :raise when
		// reading the definition fails).
		const stub = `
FakeDependency = Struct.new(:name, :force_ruby_platform)
FakeDefinition = Struct.new(:dependencies)
FakeBundler = Struct.new(:settings, :gemfile_force) do
  def definition
    raise "no Gemfile" if gemfile_force == :raise
    FakeDefinition.new([FakeDependency.new("other", true), FakeDependency.new("llm-tests-forge", gemfile_force)])
  end
end`;
		// [the program's expression, the cause]
		const cases: [string, string][] = [
			["LlmTestsForge.fallback_cause(nil)", "gem_install"],
			[
				"LlmTestsForge.fallback_cause(FakeBundler.new({ force_ruby_platform: true }, false))",
				"force_ruby_platform",
			],
			[
				"LlmTestsForge.fallback_cause(FakeBundler.new({ force_ruby_platform: false }, true))",
				"force_ruby_platform",
			],
			[
				"LlmTestsForge.fallback_cause(FakeBundler.new({ force_ruby_platform: nil }, false))",
				"lockfile",
			],
			["LlmTestsForge.fallback_cause(FakeBundler.new({}, :raise))", "lockfile"],
			["LlmTestsForge.fallback_cause", "gem_install"],
		];
		for (const [expression, cause] of cases)
			expect({
				expression,
				...(await rubyOutput(`${stub}\nprint ${expression}`, work)),
			}).toEqual({ expression, exitCode: 0, stdout: cause, stderr: "" });
	}, 600_000);

	test("the fallback gem where no native gem fits, and a native gem missing its binary, keep the plain message", async () => {
		const { work } = await builtGems();
		// [local platform, the gem installed, the npm name]
		const cases: [string, string, string][] = [
			["x86_64-freebsd", "ruby", "freebsd-x64"],
			["x86-mingw32", "ruby", "win32-ia32"],
			["arm64-darwin-25", "arm64-darwin", "darwin-arm64"],
		];
		for (const [local, installedPlatform, name] of cases) {
			const finished = await rubyOutput(
				`print LlmTestsForge.missing_binary_message(local_platform: Gem::Platform.new(${JSON.stringify(local)}), installed_gem_platform: ${JSON.stringify(installedPlatform)})`,
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

	test("on musl Linux, whichever gem is installed, the message says musl has no binary yet instead of naming linux-x64 unsupported", async () => {
		const { work } = await builtGems();
		const cases: [string, string, string][] = [
			["x86_64-linux-musl", "ruby", "linux-x64"],
			["aarch64-linux-musl", "ruby", "linux-arm64"],
			["x86_64-linux-musl", "x86_64-linux-gnu", "linux-x64"],
		];
		for (const [local, installedPlatform, name] of cases) {
			const finished = await rubyOutput(
				`print LlmTestsForge.missing_binary_message(local_platform: Gem::Platform.new(${JSON.stringify(local)}), installed_gem_platform: ${JSON.stringify(installedPlatform)})`,
				work,
			);
			expect({ local, ...finished }).toEqual({
				local,
				exitCode: 0,
				stdout: muslMessage(name),
				stderr: "",
			});
		}
	}, 600_000);

	test("gem install --platform ruby on this machine installs the fallback beside a native gem, and the installed shim says what chose it", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, fallbackGem, work } = await builtGems();
		const { home, entry, environment } = await installedFrom(
			await gemRepository([fallbackGem, hostGem], "fallback-last"),
			"ruby",
		);
		expect(await installedPlatforms(home)).toBe("ruby");
		expect(await run([entry, "--version"], work, environment)).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${fallbackGemChosenMessage(NPM_PLATFORM_NAME, HOST.gemPlatform, "gem_install")}\n`,
		});
	}, 600_000);

	test("under bundle exec, force_ruby_platform installs the fallback and the shim names it; a Gemfile.lock whose PLATFORMS lack this platform installs it too, and the shim names that", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { hostGem, foreignGem, fallbackGem, work } = await builtGems();
		const repository = await gemRepository(
			[fallbackGem, hostGem, foreignGem],
			"fallback-last",
		);
		const source = `${pathToFileURL(repository).href}/`;
		const forced = await bundledProject(work, source, {
			configuration: { BUNDLE_FORCE_RUBY_PLATFORM: "true" },
		});
		expect(forced).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${fallbackGemChosenMessage(NPM_PLATFORM_NAME, HOST.gemPlatform, "force_ruby_platform")}\n`,
		});
		// The same setting for this gem alone, in the Gemfile.
		expect(
			await bundledProject(work, source, {
				gemOptions: ", force_ruby_platform: true",
			}),
		).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${fallbackGemChosenMessage(NPM_PLATFORM_NAME, HOST.gemPlatform, "force_ruby_platform")}\n`,
		});
		// Locked on another machine: ruby and the foreign platform, not this one.
		// (A lockfile listing ruby alone is re-resolved: Bundler adds this
		// platform and installs the native gem.)
		if (FOREIGN === undefined) throw new Error("no foreign target");
		const locked = await bundledProject(work, source, {
			lockfile: [
				"GEM",
				`  remote: ${source}`,
				"  specs:",
				`    llm-tests-forge (${GEM_VERSION})`,
				`    llm-tests-forge (${GEM_VERSION}-${FOREIGN.gemPlatform})`,
				"",
				"PLATFORMS",
				"  ruby",
				`  ${FOREIGN.gemPlatform}`,
				"",
				"DEPENDENCIES",
				`  llm-tests-forge (= ${GEM_VERSION})`,
				"",
			].join("\n"),
		});
		expect(locked).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: `${fallbackGemChosenMessage(NPM_PLATFORM_NAME, HOST.gemPlatform, "lockfile")}\n`,
		});
		// A control: with neither, Bundler installs the native gem and it runs.
		expect(await bundledProject(work, source, {})).toEqual({
			exitCode: 0,
			stdout: `${FORGE_VERSION}\n`,
			stderr: "",
		});
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
