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

/** What the launcher prints when the platform has no binary or its package is not installed. */
function unsupportedMessage(platform, architecture) {
	return `llm-tests-forge has no binary for ${platform}-${architecture}; see https://github.com/albertosca/llm-tests-forge for install.sh`;
}

module.exports = { platformPackage, unsupportedMessage };
