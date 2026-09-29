import { describe, expect, test } from "bun:test";
import { RELEASE_TARGETS } from "../../scripts/release/targets";

describe("release targets", () => {
	test("the five assets carry the fixed names, in this order", () => {
		expect(RELEASE_TARGETS.map((target) => target.assetName)).toEqual([
			"llm-tests-forge-darwin-arm64",
			"llm-tests-forge-darwin-x64",
			"llm-tests-forge-linux-x64",
			"llm-tests-forge-linux-arm64",
			"llm-tests-forge-windows-x64.exe",
		]);
	});

	test("every name each ecosystem uses is unique across targets", () => {
		const fields = [
			(target: (typeof RELEASE_TARGETS)[number]) => target.bunTarget,
			(target: (typeof RELEASE_TARGETS)[number]) => target.assetName,
			(target: (typeof RELEASE_TARGETS)[number]) =>
				`${target.npmOs}-${target.npmCpu}`,
			(target: (typeof RELEASE_TARGETS)[number]) => target.wheelTag,
			(target: (typeof RELEASE_TARGETS)[number]) => target.gemPlatform,
		];
		for (const field of fields) {
			const values = RELEASE_TARGETS.map(field);
			expect(new Set(values).size).toBe(values.length);
		}
	});

	test("the ecosystem names are the measured ones", () => {
		expect(
			RELEASE_TARGETS.map((target) => [
				target.bunTarget,
				target.npmOs,
				target.npmCpu,
				target.wheelTag,
				target.gemPlatform,
			]),
		).toEqual([
			[
				"bun-darwin-arm64",
				"darwin",
				"arm64",
				"macosx_11_0_arm64",
				"arm64-darwin",
			],
			[
				"bun-darwin-x64",
				"darwin",
				"x64",
				"macosx_10_12_x86_64",
				"x86_64-darwin",
			],
			[
				"bun-linux-x64",
				"linux",
				"x64",
				"manylinux_2_17_x86_64.manylinux2014_x86_64",
				"x86_64-linux-gnu",
			],
			[
				"bun-linux-arm64",
				"linux",
				"arm64",
				"manylinux_2_17_aarch64.manylinux2014_aarch64",
				"aarch64-linux-gnu",
			],
			["bun-windows-x64", "win32", "x64", "win_amd64", "x64-mingw-ucrt"],
		]);
	});

	test("Homebrew ships the four Unix targets and never Windows", () => {
		expect(RELEASE_TARGETS.map((target) => target.homebrew)).toEqual([
			{ os: "macos", arch: "arm" },
			{ os: "macos", arch: "intel" },
			{ os: "linux", arch: "intel" },
			{ os: "linux", arch: "arm" },
			null,
		]);
	});
});
