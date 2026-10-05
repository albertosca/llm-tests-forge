#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const os = require("node:os");
const {
	libcFamily,
	platformPackage,
	unsupportedMessage,
} = require("./platform.js");

const libc = libcFamily(
	process.platform,
	process.platform === "linux" && process.report
		? process.report.getReport().header
		: undefined,
);

function refuseUnsupported() {
	console.error(unsupportedMessage(process.platform, process.arch, libc));
	process.exit(1);
}

const target = platformPackage(process.platform, process.arch);
// On musl the glibc binary cannot load. npm 9.6 and later skip its package
// (the libc field); an older npm installs it anyway, so refuse here too.
if (target === undefined || libc === "musl") refuseUnsupported();

let binaryPath;
try {
	binaryPath = require.resolve(target.binaryPath);
} catch {
	// The optional platform package is not installed (npm skipped it, or it was removed).
	refuseUnsupported();
}

// A terminal sends Ctrl+C to the whole process group. Without a handler the
// default action would kill this launcher and orphan the binary, which is
// the one that decides what an interrupt means. A handler that does nothing
// keeps the launcher waiting for the child; the child gets the signal too.
for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"])
	process.on(signalName, () => {});

const result = spawnSync(binaryPath, process.argv.slice(2), {
	stdio: "inherit",
});
if (result.error) {
	console.error(
		`llm-tests-forge could not run ${binaryPath}: ${result.error.message}`,
	);
	process.exit(1);
}
if (result.status !== null) process.exit(result.status);
// The child was killed by a signal: exit the way a shell reports it.
const signalNumber = result.signal ? os.constants.signals[result.signal] : 0;
process.exit(signalNumber ? 128 + signalNumber : 1);
