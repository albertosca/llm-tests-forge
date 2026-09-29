/**
 * The Hex package, end to end: the host binary compiled, SHA256SUMS and the
 * package's checksums.exs rendered from it, the binary served by a local
 * server, and a temporary mix project that depends on the package by path
 * installing it and running it; a corrupted download must be refused with the
 * asset named and nothing installed. Off by default; run with `bun run
 * test:packages` (sets FORGE_PACKAGES=1). It needs mix (with Hex, for
 * `mix hex.build`) on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { writeChecksums } from "../../scripts/release/checksums";
import { renderHexChecksums } from "../../scripts/release/hex-checksums";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform && target.npmCpu === process.arch,
);

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(
	command: string[],
	directory: string,
	extraEnvironment: Record<string, string> = {},
): Promise<Finished> {
	const child = Bun.spawn(command, {
		cwd: directory,
		env: { ...process.env, ...extraEnvironment },
		stdin: "ignore",
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

async function mustRun(
	command: string[],
	directory: string,
	extraEnvironment: Record<string, string> = {},
): Promise<string> {
	const finished = await run(command, directory, extraEnvironment);
	if (finished.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} exited ${finished.exitCode}: ${finished.stderr}`,
		);
	return finished.stdout;
}

/** The working directories and servers the tests created; removed once, after the last test. */
const workDirectories: string[] = [];
const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(async () => {
	for (const server of servers) await server.stop(true);
	for (const directory of workDirectories)
		await rm(directory, { recursive: true, force: true });
});

interface Built {
	work: string;
	packageCopy: string;
	binary: string;
	intactUrl: string;
	corruptedUrl: string;
}

let builtOnce: Promise<Built> | undefined;

/** Serves the files of `directory` by name; `corrupt` flips the first byte of what it serves. */
function serve(directory: string, corrupt: boolean): string {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			const file = Bun.file(join(directory, name));
			if (name === "" || name.includes("/") || !(await file.exists()))
				return new Response("not found", { status: 404 });
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (corrupt && bytes.length > 0) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			return new Response(bytes);
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

/** The host binary, SHA256SUMS and a copy of the package with its checksums.exs rendered, built once; two servers, one intact and one corrupting. */
function built(): Promise<Built> {
	builtOnce ??= (async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-hex-e2e-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await buildBinaries(binaries, HOST.bunTarget);
		// The other targets get small stand-ins: checksums.exs lists every asset, and only the host's is downloaded.
		for (const target of RELEASE_TARGETS)
			if (target !== HOST)
				await writeFile(join(binaries, target.assetName), target.assetName);
		await writeChecksums(binaries);
		const packageCopy = join(work, "package");
		await cp(join(REPOSITORY, "packages/hex"), packageCopy, {
			recursive: true,
		});
		await renderHexChecksums(
			binaries,
			REPOSITORY,
			join(packageCopy, "checksums.exs"),
		);
		return {
			work,
			packageCopy,
			binary: join(binaries, HOST.assetName),
			intactUrl: serve(binaries, false),
			corruptedUrl: serve(binaries, true),
		};
	})();
	return builtOnce;
}

/** A fresh mix project that depends on the package by path, its dependency already compiled. */
async function consumerProject(): Promise<string> {
	const { work, packageCopy } = await built();
	const project = await mkdtemp(join(work, "consumer-"));
	await writeFile(
		join(project, "mix.exs"),
		`defmodule Consumer.MixProject do
  use Mix.Project
  def project, do: [app: :consumer, version: "0.0.1", deps: [{:llm_tests_forge, path: ${JSON.stringify(packageCopy)}}]]
end
`,
	);
	await mustRun(["mix", "deps.compile"], project);
	return project;
}

describe.skipIf(!packages)("hex package", () => {
	test("install downloads the host binary, verifies it and makes it executable; the passthrough task then runs it", async () => {
		const { intactUrl, binary } = await built();
		const project = await consumerProject();
		const environment = { LLM_TESTS_FORGE_BASE_URL: intactUrl };
		const installed = await run(
			["mix", "llm_tests_forge.install"],
			project,
			environment,
		);
		expect(installed.exitCode).toBe(0);
		expect(installed.stdout).toContain(`Downloading ${intactUrl}/`);
		const installedPath = join(project, "_build", "llm-tests-forge");
		expect(installed.stdout).toContain(installedPath);
		expect((await stat(installedPath)).mode & 0o111).not.toBe(0);
		expect(await Bun.file(installedPath).bytes()).toEqual(
			await Bun.file(binary).bytes(),
		);
		expect(
			await run(["mix", "llm_tests_forge", "--version"], project, environment),
		).toEqual({ exitCode: 0, stdout: `${FORGE_VERSION}\n`, stderr: "" });
	}, 600_000);

	test("the passthrough task installs a missing binary first (progress on stderr, stdout the binary's alone) and --if-missing then does nothing", async () => {
		const { intactUrl } = await built();
		const project = await consumerProject();
		const environment = { LLM_TESTS_FORGE_BASE_URL: intactUrl };
		const first = await run(
			["mix", "llm_tests_forge", "--version"],
			project,
			environment,
		);
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toBe(`${FORGE_VERSION}\n`);
		expect(first.stderr).toContain("Installed ");
		// A base URL that would fail proves the second call does not download.
		const skipped = await run(
			["mix", "llm_tests_forge.install", "--if-missing"],
			project,
			{
				LLM_TESTS_FORGE_BASE_URL: "http://127.0.0.1:1",
			},
		);
		expect(skipped.exitCode).toBe(0);
		expect(skipped.stdout).toContain("is already installed");
	}, 600_000);

	test("a binary left by another package version is reinstalled, and one whose sidecar matches is kept", async () => {
		const { intactUrl } = await built();
		const project = await consumerProject();
		const environment = { LLM_TESTS_FORGE_BASE_URL: intactUrl };
		await mustRun(["mix", "llm_tests_forge.install"], project, environment);
		const installedPath = join(project, "_build", "llm-tests-forge");
		const sidecarPath = `${installedPath}.version`;
		const marker = '#!/bin/sh\necho "stand-in"\n';
		const plant = async (sidecar: string | undefined) => {
			await writeFile(installedPath, marker, { mode: 0o755 });
			if (sidecar === undefined) await rm(sidecarPath, { force: true });
			else await writeFile(sidecarPath, sidecar);
		};
		// Matching sidecar (the one the install wrote): the stand-in is kept.
		const matching = await Bun.file(sidecarPath).text();
		await plant(matching);
		expect(
			await run(["mix", "llm_tests_forge", "--version"], project, environment),
		).toEqual({ exitCode: 0, stdout: "stand-in\n", stderr: "" });
		// A sidecar from another version, and no sidecar at all: reinstalled.
		for (const stale of ["0".repeat(64), undefined]) {
			await plant(stale);
			const reinstalled = await run(
				["mix", "llm_tests_forge", "--version"],
				project,
				environment,
			);
			expect(reinstalled.stdout).toBe(`${FORGE_VERSION}\n`);
			expect(reinstalled.stderr).toContain("Installed ");
			expect(await Bun.file(sidecarPath).text()).toBe(matching);
		}
		// --if-missing treats a stale binary as missing too.
		await plant("0".repeat(64));
		const refreshed = await run(
			["mix", "llm_tests_forge.install", "--if-missing"],
			project,
			environment,
		);
		expect(refreshed.stdout).toContain("Installed ");
	}, 600_000);

	test("review is refused through mix with exit 2, naming the installed binary to run directly", async () => {
		const { intactUrl } = await built();
		const project = await consumerProject();
		const finished = await run(["mix", "llm_tests_forge", "review"], project, {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
		});
		expect(finished.exitCode).toBe(2);
		expect(finished.stdout).toBe("");
		expect(finished.stderr).toMatch(
			/^review needs the terminal; run \/.*\/_build\/llm-tests-forge review\n$/,
		);
		expect(finished.stderr).toContain(project.replace(/^\/private/, ""));
	}, 600_000);

	test("the passthrough task exits with the binary's own status, and passes its stdout and stderr through", async () => {
		const { intactUrl } = await built();
		const project = await consumerProject();
		const environment = { LLM_TESTS_FORGE_BASE_URL: intactUrl };
		await mustRun(["mix", "llm_tests_forge.install"], project, environment);
		const installedPath = join(project, "_build", "llm-tests-forge");
		const direct = await run([installedPath, "no-such-command"], project);
		expect(direct.exitCode).not.toBe(0);
		const throughMix = await run(
			["mix", "llm_tests_forge", "no-such-command"],
			project,
			environment,
		);
		expect(throughMix.exitCode).toBe(direct.exitCode);
		expect(throughMix.stderr).toBe(direct.stderr);
		expect(throughMix.stdout).toBe(direct.stdout);
	}, 600_000);

	test("a corrupted download is refused naming the asset, and no binary is left", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { corruptedUrl } = await built();
		const project = await consumerProject();
		const finished = await run(["mix", "llm_tests_forge.install"], project, {
			LLM_TESTS_FORGE_BASE_URL: corruptedUrl,
		});
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(
			`checksum mismatch for ${HOST.assetName}`,
		);
		expect(await readdir(join(project, "_build"))).toEqual(["dev"]);
	}, 600_000);

	test("an unreachable release is refused naming the asset and the HTTP status", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const { intactUrl } = await built();
		const project = await consumerProject();
		const finished = await run(["mix", "llm_tests_forge.install"], project, {
			LLM_TESTS_FORGE_BASE_URL: `${intactUrl}/missing-directory`,
		});
		expect(finished.exitCode).not.toBe(0);
		expect(finished.stderr).toContain(`downloading ${HOST.assetName}`);
		expect(finished.stderr).toContain("HTTP 404");
		expect(await readdir(join(project, "_build"))).toEqual(["dev"]);
	}, 600_000);

	test("the package's own ExUnit tests pass", async () => {
		const { packageCopy } = await built();
		const finished = await run(["mix", "test"], packageCopy);
		expect(finished.stdout).toMatch(/Result: \d+ passed\n$/);
		expect(finished.exitCode).toBe(0);
	}, 600_000);

	test("mix hex.build succeeds without an account and packs the checksums but not the tests", async () => {
		const { packageCopy } = await built();
		const finished = await run(["mix", "hex.build"], packageCopy);
		expect(finished.stderr).toBe("");
		expect(finished.exitCode).toBe(0);
		expect(finished.stdout).toContain(`Version: ${FORGE_VERSION}`);
		expect(finished.stdout).toContain("checksums.exs");
		expect(finished.stdout).toContain(
			"lib/mix/tasks/llm_tests_forge.install.ex",
		);
		expect(finished.stdout).not.toContain("test/");
	}, 600_000);
});
