/**
 * The npm packages, end to end: the host binary compiled, the packages
 * rendered from it, packed, and installed into a temporary prefix, where
 * the launcher must run the binary; and the same install with the platform
 * package removed. Off by default; run with `bun run test:packages` (sets
 * FORGE_PACKAGES=1). It needs npm on the PATH.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBinaries } from "../../scripts/release/build-binaries";
import { renderNpmPackages } from "../../scripts/release/npm-packages";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";

const packages = process.env.FORGE_PACKAGES === "1";
const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform && target.npmCpu === process.arch,
);

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function run(command: string[], directory: string): Promise<Finished> {
	const child = Bun.spawn(command, {
		cwd: directory,
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

async function installedPrefix(): Promise<{
	prefix: string;
	/** The temporary directory holding everything the install built; the caller removes it. */
	work: string;
	platformPackage: string;
}> {
	if (HOST === undefined) throw new Error("this machine is not a target");
	const work = await mkdtemp(join(tmpdir(), "forge-npm-e2e-"));
	const binaries = join(work, "binaries");
	await buildBinaries(binaries, HOST.bunTarget);
	// The renderer wants every target's binary; the host's stands in for the
	// others, which are packed only by name here and never installed.
	for (const target of RELEASE_TARGETS)
		if (target !== HOST)
			await Bun.write(
				join(binaries, target.assetName),
				Bun.file(join(binaries, HOST.assetName)),
			);
	const out = join(work, "npm");
	await renderNpmPackages(binaries, out);
	const platformDirectory = join(out, `${HOST.npmOs}-${HOST.npmCpu}`);
	const tarballs = join(work, "tarballs");
	await mkdir(tarballs);
	const packed: string[] = [];
	for (const directory of [join(out, "main"), platformDirectory]) {
		const output = await mustRun(
			["npm", "pack", "--pack-destination", tarballs, "--json"],
			directory,
		);
		// npm 12 prints an object keyed by package name.
		const [entry] = Object.values(
			JSON.parse(output) as Record<string, { filename: string }>,
		);
		if (entry === undefined) throw new Error("npm pack listed no file");
		packed.push(join(tarballs, entry.filename));
	}
	const prefix = join(work, "consumer");
	// Hermetic: no optional dependency is fetched, and the registry is an
	// unreachable address, so nothing published can be picked up.
	await mustRun(
		[
			"npm",
			"install",
			"--prefix",
			prefix,
			"--omit=optional",
			"--registry",
			"http://127.0.0.1:9",
			"--fetch-retries=0",
			...packed,
		],
		work,
	);
	return {
		prefix,
		work,
		platformPackage: `@llm-tests-forge/${HOST.npmOs}-${HOST.npmCpu}`,
	};
}

const MAIN_BIN = join(import.meta.dir, "../../packages/npm/main/bin");

/** An installed-looking tree: the real launcher, and a Node script standing in for the platform binary. */
async function launcherWithChild(childSource: string): Promise<string> {
	if (HOST === undefined) throw new Error("this machine is not a target");
	const prefix = await mkdtemp(join(tmpdir(), "forge-npm-signals-"));
	const launcherDirectory = join(prefix, "node_modules/llm-tests-forge/bin");
	await mkdir(launcherDirectory, { recursive: true });
	for (const file of ["llm-tests-forge.js", "platform.js"])
		await copyFile(join(MAIN_BIN, file), join(launcherDirectory, file));
	const childDirectory = join(
		prefix,
		`node_modules/@llm-tests-forge/${HOST.npmOs}-${HOST.npmCpu}/bin`,
	);
	await mkdir(childDirectory, { recursive: true });
	await writeFile(join(childDirectory, "llm-tests-forge"), childSource, {
		mode: 0o755,
	});
	return join(launcherDirectory, "llm-tests-forge.js");
}

/** The launcher started as its own process group leader, as a terminal's foreground job is. */
function startInOwnGroup(launcher: string) {
	const child = spawn("node", [launcher], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const finished = new Promise<number | null>((resolveExit) => {
		child.on("close", (code) => resolveExit(code));
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
		if (child.pid === undefined) throw new Error("launcher did not start");
		process.kill(-child.pid, signalName);
	}
	return { finished, waitFor, signalGroup, hasExited: () => exited };
}

const INTERRUPT_COUNTING_CHILD = `#!/usr/bin/env node
let count = 0;
process.on("SIGINT", () => {
	count += 1;
	console.log("interrupt " + count);
	if (count === 2) process.exit(130);
});
console.log("ready");
setInterval(() => {}, 1000);
`;

const SELF_TERMINATING_CHILD = `#!/usr/bin/env node
process.kill(process.pid, "SIGTERM");
setInterval(() => {}, 1000);
`;

describe.skipIf(!packages || process.platform === "win32")(
	"the launcher and signals",
	() => {
		test("a Ctrl+C sent to the whole process group leaves the launcher attached: the child sees each one, and the second ends both with 130", async () => {
			const launcher = startInOwnGroup(
				await launcherWithChild(INTERRUPT_COUNTING_CHILD),
			);
			await launcher.waitFor("ready");
			launcher.signalGroup("SIGINT");
			await launcher.waitFor("interrupt 1");
			await Bun.sleep(300);
			expect(launcher.hasExited()).toBe(false);
			launcher.signalGroup("SIGINT");
			expect(await launcher.finished).toBe(130);
		}, 60_000);

		test("a child killed by SIGTERM makes the launcher exit 143, the way a shell reports it", async () => {
			const launcher = startInOwnGroup(
				await launcherWithChild(SELF_TERMINATING_CHILD),
			);
			expect(await launcher.finished).toBe(143);
		}, 60_000);
	},
);

describe.skipIf(!packages)("npm packages", () => {
	test("main and host platform package, packed and installed into a temporary prefix, run the binary through the launcher and carry the LICENSE", async () => {
		const { prefix, work, platformPackage } = await installedPrefix();
		try {
			const finished = await run(
				[join(prefix, "node_modules/.bin/llm-tests-forge"), "--version"],
				prefix,
			);
			expect(finished).toEqual({
				exitCode: 0,
				stdout: `${FORGE_VERSION}\n`,
				stderr: "",
			});
			const license = await readFile(
				join(import.meta.dir, "../../LICENSE"),
				"utf8",
			);
			for (const installed of ["llm-tests-forge", platformPackage])
				expect(
					await readFile(
						join(prefix, "node_modules", installed, "LICENSE"),
						"utf8",
					),
				).toBe(license);
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}, 600_000);

	test("with the platform package removed, the launcher names the platform and the install script and exits 1", async () => {
		const { prefix, work, platformPackage } = await installedPrefix();
		try {
			await rm(join(prefix, "node_modules", platformPackage), {
				recursive: true,
			});
			const finished = await run(
				[join(prefix, "node_modules/.bin/llm-tests-forge"), "--version"],
				prefix,
			);
			expect(finished).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `llm-tests-forge has no binary for ${process.platform}-${process.arch}; see https://github.com/albertosca/llm-tests-forge for install.sh\n`,
			});
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}, 600_000);
});
