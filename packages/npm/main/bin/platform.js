"use strict";

const BINARY_NAME = "llm-tests-forge";

// One entry per platform the forge ships a binary for. The default test suite
// checks this table against scripts/release/targets.ts.
const PLATFORM_PACKAGES = {
	"darwin-arm64": "@llm-tests-forge/darwin-arm64",
	"darwin-x64": "@llm-tests-forge/darwin-x64",
	"linux-x64": "@llm-tests-forge/linux-x64",
	"linux-arm64": "@llm-tests-forge/linux-arm64",
	"win32-x64": "@llm-tests-forge/win32-x64",
};

/** The package and the module path of the binary for a platform, or undefined when none is shipped. */
function platformPackage(platform, architecture) {
	const key = `${platform}-${architecture}`;
	if (!Object.hasOwn(PLATFORM_PACKAGES, key)) return undefined;
	const packageName = PLATFORM_PACKAGES[key];
	const binaryFile = platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
	return { packageName, binaryPath: `${packageName}/bin/${binaryFile}` };
}

/**
 * The C library of a Linux machine from its process report's header:
 * glibc when the header carries glibcVersionRuntime (Node leaves it out on
 * musl), unknown without a report, undefined off Linux.
 */
function libcFamily(platform, reportHeader) {
	if (platform !== "linux") return undefined;
	if (reportHeader === undefined) return "unknown";
	return typeof reportHeader.glibcVersionRuntime === "string"
		? "glibc"
		: "musl";
}

/**
 * What the launcher prints when the platform has no binary or its package is
 * not installed. On musl Linux no release binary runs (the Linux ones need
 * glibc), so it says so rather than pointing at install.sh.
 */
function unsupportedMessage(platform, architecture, libc) {
	const name = `${platform}-${architecture}`;
	if (libc === "musl")
		return `llm-tests-forge has no binary for musl/Alpine yet (${name}-musl): the ${name} binary needs glibc; see https://github.com/albertosca/llm-tests-forge`;
	return `llm-tests-forge has no binary for ${name}; see https://github.com/albertosca/llm-tests-forge for install.sh`;
}

module.exports = { libcFamily, platformPackage, unsupportedMessage };
