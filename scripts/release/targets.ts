/** One platform the forge ships a compiled binary for, and every name each package ecosystem calls it. */
export interface ReleaseTarget {
	/** The `--target` value of `bun build --compile`. */
	bunTarget: string;
	/** The file name of the raw binary on the GitHub Release. */
	assetName: string;
	npmOs: string;
	npmCpu: string;
	/** The platform part of the wheel's `py3-none-<tag>` file name. */
	wheelTag: string;
	gemPlatform: string;
	/** The Homebrew formula's `on_<os>` / `on_<arch>` pair; null when no formula ships this target. */
	homebrew: { os: "macos" | "linux"; arch: "arm" | "intel" } | null;
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
	{
		bunTarget: "bun-darwin-arm64",
		assetName: "llm-tests-forge-darwin-arm64",
		npmOs: "darwin",
		npmCpu: "arm64",
		wheelTag: "macosx_11_0_arm64",
		gemPlatform: "arm64-darwin",
		homebrew: { os: "macos", arch: "arm" },
	},
	{
		bunTarget: "bun-darwin-x64",
		assetName: "llm-tests-forge-darwin-x64",
		npmOs: "darwin",
		npmCpu: "x64",
		wheelTag: "macosx_10_12_x86_64",
		gemPlatform: "x86_64-darwin",
		homebrew: { os: "macos", arch: "intel" },
	},
	{
		bunTarget: "bun-linux-x64",
		assetName: "llm-tests-forge-linux-x64",
		npmOs: "linux",
		npmCpu: "x64",
		wheelTag: "manylinux_2_17_x86_64.manylinux2014_x86_64",
		gemPlatform: "x86_64-linux-gnu",
		homebrew: { os: "linux", arch: "intel" },
	},
	{
		bunTarget: "bun-linux-arm64",
		assetName: "llm-tests-forge-linux-arm64",
		npmOs: "linux",
		npmCpu: "arm64",
		wheelTag: "manylinux_2_17_aarch64.manylinux2014_aarch64",
		gemPlatform: "aarch64-linux-gnu",
		homebrew: { os: "linux", arch: "arm" },
	},
	{
		bunTarget: "bun-windows-x64",
		assetName: "llm-tests-forge-windows-x64.exe",
		npmOs: "win32",
		npmCpu: "x64",
		wheelTag: "win_amd64",
		gemPlatform: "x64-mingw-ucrt",
		homebrew: null,
	},
];

/** The name of the checksum file that sits beside the binaries on a release. */
export const CHECKSUMS_FILE_NAME = "SHA256SUMS";
