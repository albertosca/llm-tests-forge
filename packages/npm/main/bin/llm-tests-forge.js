#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { platformPackage, unsupportedMessage } = require("./platform.js");

function refuseUnsupported() {
	console.error(unsupportedMessage(process.platform, process.arch));
	process.exit(1);
}

const target = platformPackage(process.platform, process.arch);
if (target === undefined) refuseUnsupported();

let binaryPath;
try {
	binaryPath = require.resolve(target.binaryPath);
} catch {
	// The optional platform package is not installed (npm skipped it, or it was removed).
	refuseUnsupported();
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
	stdio: "inherit",
});
if (result.error) {
	console.error(
		`llm-tests-forge could not run ${binaryPath}: ${result.error.message}`,
	);
	process.exit(1);
}
process.exit(result.status ?? 1);
