import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBinaries,
	runBuildBinaries,
} from "../../scripts/release/build-binaries";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { UsageError } from "../../src/core/errors";
import { FORGE_VERSION } from "../../src/core/version";

const HOST = RELEASE_TARGETS.find(
	(target) =>
		target.npmOs === process.platform && target.npmCpu === process.arch,
);

describe("build-binaries", () => {
	test("the host target compiles into the out directory under its asset name, executable, and prints the version", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const parent = await mkdtemp(join(tmpdir(), "forge-release-build-"));
		const printed: string[] = [];
		const exitCode = await runBuildBinaries(
			[join(parent, "dist"), "--only", HOST.bunTarget],
			(line) => printed.push(line),
		);
		const binary = join(parent, "dist", HOST.assetName);
		expect({ exitCode, printed }).toEqual({ exitCode: 0, printed: [binary] });
		expect((await stat(binary)).mode & 0o111).not.toBe(0);
		const run = Bun.spawnSync([binary, "--version"]);
		expect({
			exitCode: run.exitCode,
			output: run.stdout.toString(),
		}).toEqual({ exitCode: 0, output: `${FORGE_VERSION}\n` });
	}, 120_000);

	test("a build that cannot write its binary fails naming the target and the file", async () => {
		if (HOST === undefined) throw new Error("this machine is not a target");
		const parent = await mkdtemp(join(tmpdir(), "forge-release-build-"));
		// A read-only out directory makes the compile fail.
		await mkdir(join(parent, "dist"), { mode: 0o500 });
		await expect(
			buildBinaries(join(parent, "dist"), HOST.bunTarget),
		).rejects.toThrow(
			new RegExp(
				`bun build failed for ${HOST.bunTarget}: .*\\(file: ${join(parent, "dist", HOST.assetName)}\\)`,
				"s",
			),
		);
	}, 120_000);

	test("an unknown --only target is a usage error listing the real ones", async () => {
		const parent = await mkdtemp(join(tmpdir(), "forge-release-build-"));
		const failure = buildBinaries(join(parent, "dist"), "bun-linux-riscv");
		await expect(failure).rejects.toBeInstanceOf(UsageError);
		await expect(failure).rejects.toThrow(
			"--only bun-linux-riscv is not a release target (one of bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64, bun-windows-x64)",
		);
	});

	test("the command line wants a directory first and only an optional --only <target> after it", async () => {
		const usage =
			"usage: build-binaries.ts <out-directory> [--only <bunTarget>]";
		for (const argumentsList of [
			[],
			["--only", "bun-linux-x64"],
			["dist", "--only"],
			["dist", "--all"],
			["dist", "--only", "bun-linux-x64", "extra"],
		])
			await expect(runBuildBinaries(argumentsList, () => {})).rejects.toThrow(
				usage,
			);
	});
});
