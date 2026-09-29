/**
 * The npm packages, end to end: the host binary compiled, the packages
 * rendered from it, packed, and installed into a temporary prefix, where
 * the launcher must run the binary; and the same install with the platform
 * package removed. Off by default; run with `bun run test:packages` (sets
 * FORGE_PACKAGES=1). It needs npm on the PATH.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
	await mustRun(["npm", "install", "--prefix", prefix, ...packed], work);
	return {
		prefix,
		platformPackage: `@llm-tests-forge/${HOST.npmOs}-${HOST.npmCpu}`,
	};
}

describe.skipIf(!packages)("npm packages", () => {
	test("main and host platform package, packed and installed into a temporary prefix, run the binary through the launcher", async () => {
		const { prefix } = await installedPrefix();
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
		} finally {
			await rm(prefix, { recursive: true, force: true });
		}
	}, 600_000);

	test("with the platform package removed, the launcher names the platform and the install script and exits 1", async () => {
		const { prefix, platformPackage } = await installedPrefix();
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
			await rm(prefix, { recursive: true, force: true });
		}
	}, 600_000);
});
