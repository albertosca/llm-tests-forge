/**
 * install.sh, end to end: the host binary compiled and checksummed, served by
 * a local server, and the script run into a temporary directory; a corrupted
 * download must be refused with the asset named and nothing installed, and an
 * unsupported platform (a fake `uname` first on the PATH) must exit 1 naming
 * it. Off by default; run with `bun run test:packages` (sets FORGE_PACKAGES=1).
 * It needs `sh` and `curl` on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { writeChecksums } from "../../scripts/release/checksums";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const INSTALL_SCRIPT = join(REPOSITORY, "install.sh");
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform &&
		target.npmCpu === process.arch &&
		target.homebrew !== null,
);

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runScript(
	argumentsList: string[],
	extraEnvironment: Record<string, string>,
): Promise<Finished> {
	const child = Bun.spawn(["sh", INSTALL_SCRIPT, ...argumentsList], {
		cwd: REPOSITORY,
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

const workDirectories: string[] = [];
const servers: { stop: (force: boolean) => unknown }[] = [];
afterAll(async () => {
	for (const server of servers) await server.stop(true);
	for (const directory of workDirectories)
		await rm(directory, { recursive: true, force: true });
});

/** Serves the files of `directory` by name; `corrupt` flips the first byte of the binary it serves (never SHA256SUMS). */
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
			if (corrupt && name !== "SHA256SUMS" && bytes.length > 0)
				bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			return new Response(bytes);
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

interface Built {
	work: string;
	intactUrl: string;
	corruptedUrl: string;
}

let builtOnce: Promise<Built> | undefined;

/** The host binary and SHA256SUMS, built once; two servers, one intact and one corrupting. */
function built(): Promise<Built> {
	builtOnce ??= (async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const work = await mkdtemp(join(tmpdir(), "forge-install-e2e-"));
		workDirectories.push(work);
		const binaries = join(work, "binaries");
		await buildBinaries(binaries, HOST.bunTarget);
		await writeChecksums(binaries);
		return {
			work,
			intactUrl: serve(binaries, false),
			corruptedUrl: serve(binaries, true),
		};
	})();
	return builtOnce;
}

/** A directory holding a `uname` that answers `-s` and `-m` with the given values, to put first on the PATH. */
async function fakeUname(
	work: string,
	kernelName: string,
	machineName: string,
): Promise<string> {
	const directory = await mkdtemp(join(work, "fake-uname-"));
	const path = join(directory, "uname");
	await writeFile(
		path,
		`#!/bin/sh\ncase "$1" in\n-s) echo "${kernelName}" ;;\n-m) echo "${machineName}" ;;\n*) echo "${kernelName}" ;;\nesac\n`,
	);
	await chmod(path, 0o755);
	return directory;
}

describe.skipIf(!packages || HOST === undefined)("install.sh", () => {
	test("downloads the host binary, verifies it, installs it executable into --dir and says where and whether it is on the PATH", async () => {
		const { work, intactUrl } = await built();
		const target = await mkdtemp(join(work, "target-"));
		const installDirectory = join(target, "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
		});
		expect(finished.stderr).toBe("");
		expect(finished.exitCode).toBe(0);
		const installedPath = join(installDirectory, "llm-tests-forge");
		expect(finished.stdout).toContain(`Installed ${installedPath}`);
		expect(finished.stdout).toContain(
			`${installDirectory} is not on your PATH`,
		);
		expect((await stat(installedPath)).mode & 0o777).toBe(0o755);
		expect(await readdir(installDirectory)).toEqual(["llm-tests-forge"]);
		const version = Bun.spawn([installedPath, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(version.stdout).text()).toBe(
			`${FORGE_VERSION}\n`,
		);
		expect(await version.exited).toBe(0);
		// The same directory on the PATH is reported as such, and a second run replaces the binary.
		const again = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
			PATH: `${installDirectory}:${process.env.PATH ?? ""}`,
		});
		expect(again.exitCode).toBe(0);
		expect(again.stdout).toContain(`${installDirectory} is on your PATH.`);
	}, 600_000);

	test("a corrupted download is refused, naming the asset, and nothing is installed", async () => {
		const { work, corruptedUrl } = await built();
		const target = await mkdtemp(join(work, "target-"));
		const installDirectory = join(target, "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: corruptedUrl,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`checksum mismatch for ${HOST?.assetName}`,
		);
		expect(finished.stderr).toContain("nothing was installed");
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("a SHA256SUMS that does not list the asset is refused, and a name that only contains it does not count", async () => {
		const { work } = await built();
		if (HOST === undefined) throw new Error("this machine is not a target");
		const served = await mkdtemp(join(work, "served-"));
		await writeFile(join(served, HOST.assetName), "not a real binary");
		await writeFile(
			join(served, "SHA256SUMS"),
			`${"0".repeat(64)}  ${HOST.assetName}.exe\n${"0".repeat(64)}  x${HOST.assetName}\n`,
		);
		const target = await mkdtemp(join(work, "target-"));
		const finished = await runScript(["--dir", join(target, "bin")], {
			LLM_TESTS_FORGE_BASE_URL: serve(served, false),
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`SHA256SUMS does not list ${HOST.assetName}`,
		);
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("an unsupported platform exits 1 naming it, in npm-style names, and installs nothing", async () => {
		const { work, intactUrl } = await built();
		for (const [kernelName, machineName, expected] of [
			["FreeBSD", "amd64", "freebsd-x64"],
			["Linux", "i686", "linux-i686"],
			["MINGW64_NT-10.0", "x86_64", "mingw64_nt-10.0-x64"],
		] as const) {
			const target = await mkdtemp(join(work, "target-"));
			const fake = await fakeUname(work, kernelName, machineName);
			const finished = await runScript(["--dir", join(target, "bin")], {
				LLM_TESTS_FORGE_BASE_URL: intactUrl,
				PATH: `${fake}:${process.env.PATH ?? ""}`,
			});
			expect(finished.exitCode).toBe(1);
			expect(finished.stderr).toContain(
				`llm-tests-forge has no binary for ${expected}; see https://github.com/albertosca/llm-tests-forge`,
			);
			expect(await readdir(target)).toEqual([]);
		}
	}, 600_000);

	test("a Linux ARM machine maps to the linux-arm64 asset (a fake uname, and a server holding nothing, so the download is refused on every host)", async () => {
		const { work } = await built();
		const emptyUrl = serve(await mkdtemp(join(work, "served-empty-")), false);
		const target = await mkdtemp(join(work, "target-"));
		const fake = await fakeUname(work, "Linux", "aarch64");
		const finished = await runScript(["--dir", join(target, "bin")], {
			LLM_TESTS_FORGE_BASE_URL: emptyUrl,
			PATH: `${fake}:${process.env.PATH ?? ""}`,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stdout).toContain(
			`${emptyUrl}/llm-tests-forge-linux-arm64`,
		);
		expect(finished.stderr).toContain(
			`cannot download ${emptyUrl}/llm-tests-forge-linux-arm64`,
		);
		expect(await readdir(target)).toEqual([]);
	}, 600_000);

	test("a directory where the binary goes is refused naming it, and nothing is moved into it", async () => {
		const { work, intactUrl } = await built();
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		const occupied = join(installDirectory, "llm-tests-forge");
		await mkdir(occupied, { recursive: true });
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
		});
		expect(finished.exitCode).toBe(1);
		expect(finished.stderr).toContain(
			`${occupied} is a directory; remove it or choose another --dir; nothing was installed`,
		);
		expect(finished.stdout).not.toContain("Installed");
		expect(await readdir(occupied)).toEqual([]);
		expect(await readdir(installDirectory)).toEqual(["llm-tests-forge"]);
	}, 600_000);

	test("a SHA256SUMS line in binary mode (hash *name, as sha256sum -b writes it) is accepted", async () => {
		const { work } = await built();
		if (HOST === undefined) throw new Error("this machine is not a target");
		const served = await mkdtemp(join(work, "served-"));
		const content = "a stand-in binary\n";
		await writeFile(join(served, HOST.assetName), content);
		const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
		await writeFile(join(served, "SHA256SUMS"), `${hash} *${HOST.assetName}\n`);
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: serve(served, false),
		});
		expect(finished.stderr).toBe("");
		expect(finished.exitCode).toBe(0);
		expect(
			await Bun.file(join(installDirectory, "llm-tests-forge")).text(),
		).toBe(content);
	}, 600_000);

	test("a TERM that arrives while the binary is being put in place removes the temporary copy and stops the script", async () => {
		const { work, intactUrl } = await built();
		const installDirectory = join(await mkdtemp(join(work, "target-")), "bin");
		// A fake mv first on the PATH: it signals the script that ran it and moves nothing,
		// so the copy beside the target is exactly what an interrupted install leaves.
		const fakeMoveDirectory = await mkdtemp(join(work, "fake-mv-"));
		await writeFile(
			join(fakeMoveDirectory, "mv"),
			'#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n',
		);
		await chmod(join(fakeMoveDirectory, "mv"), 0o755);
		const finished = await runScript(["--dir", installDirectory], {
			LLM_TESTS_FORGE_BASE_URL: intactUrl,
			PATH: `${fakeMoveDirectory}:${process.env.PATH ?? ""}`,
		});
		expect(finished.exitCode).toBe(143);
		expect(finished.stdout).not.toContain("Installed");
		expect(await readdir(installDirectory)).toEqual([]);
	}, 600_000);

	test("--version picks the release path, an unknown option is a usage error (exit 2), and --dir without a value too", async () => {
		const { work } = await built();
		const target = await mkdtemp(join(work, "target-"));
		// A fake curl first on the PATH records the URL it is asked for and fails, so the real network is never touched.
		const fakeCurlDirectory = await mkdtemp(join(work, "fake-curl-"));
		const requestedPath = join(fakeCurlDirectory, "requested");
		const fakeCurl = join(fakeCurlDirectory, "curl");
		await writeFile(
			fakeCurl,
			`#!/bin/sh\nfor argument; do last="$argument"; done\necho "$last" >> "${requestedPath}"\nexit 22\n`,
		);
		await chmod(fakeCurl, 0o755);
		const environment = {
			PATH: `${fakeCurlDirectory}:${process.env.PATH ?? ""}`,
		};
		const tagged = await runScript(
			["--dir", join(target, "bin"), "--version", "1.2.3"],
			environment,
		);
		expect(tagged.exitCode).toBe(1);
		expect(await Bun.file(requestedPath).text()).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/download/v1.2.3/${HOST?.assetName}\n`,
		);
		await rm(requestedPath);
		const latest = await runScript(["--dir", join(target, "bin")], environment);
		expect(latest.exitCode).toBe(1);
		expect(await Bun.file(requestedPath).text()).toContain(
			`https://github.com/albertosca/llm-tests-forge/releases/latest/download/${HOST?.assetName}\n`,
		);
		for (const argumentsList of [["--bogus"], ["--dir"], ["--version"]]) {
			const finished = await runScript(argumentsList, {});
			expect(finished.exitCode).toBe(2);
			expect(finished.stderr).toContain("usage: install.sh");
		}
		expect(await readdir(target)).toEqual([]);
	}, 600_000);
});
