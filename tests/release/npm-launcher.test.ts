import { describe, expect, test } from "bun:test";
import {
	libcFamily,
	platformPackage,
	unsupportedMessage,
} from "../../packages/npm/main/bin/platform";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import { muslMessage } from "../helpers/platform-messages";

describe("the npm launcher's platform mapping", () => {
	test("every release target maps to its own package and binary path, .exe only on win32", () => {
		for (const target of RELEASE_TARGETS) {
			const packageName = `@llm-tests-forge/${target.npmOs}-${target.npmCpu}`;
			const binaryFile =
				target.npmOs === "win32" ? "llm-tests-forge.exe" : "llm-tests-forge";
			expect(platformPackage(target.npmOs, target.npmCpu)).toEqual({
				packageName,
				binaryPath: `${packageName}/bin/${binaryFile}`,
			});
		}
	});

	test("platforms the forge ships no binary for map to nothing", () => {
		for (const [platform, architecture] of [
			["linux", "ia32"],
			["freebsd", "x64"],
			["win32", "arm64"],
			["darwin", ""],
		] as const)
			expect(platformPackage(platform, architecture)).toBeUndefined();
	});

	test("the message names the platform and the install script, in the words every package uses", () => {
		expect(unsupportedMessage("linux", "ia32")).toBe(
			"llm-tests-forge has no binary for linux-ia32; see https://github.com/albertosca/llm-tests-forge for install.sh",
		);
		expect(unsupportedMessage("linux", "x64", "glibc")).toBe(
			"llm-tests-forge has no binary for linux-x64; see https://github.com/albertosca/llm-tests-forge for install.sh",
		);
		expect(unsupportedMessage("linux", "x64", "unknown")).toBe(
			"llm-tests-forge has no binary for linux-x64; see https://github.com/albertosca/llm-tests-forge for install.sh",
		);
	});

	test("on musl Linux the message says musl has no binary yet, in the words every package uses, instead of naming linux-x64 unsupported", () => {
		expect(unsupportedMessage("linux", "x64", "musl")).toBe(
			muslMessage("linux-x64"),
		);
		expect(unsupportedMessage("linux", "arm64", "musl")).toBe(
			muslMessage("linux-arm64"),
		);
	});

	test("the C library comes from the process report: glibc when it carries glibcVersionRuntime, musl when it does not, unknown without a report, and none off Linux", () => {
		expect(libcFamily("linux", { glibcVersionRuntime: "2.39" })).toBe("glibc");
		expect(libcFamily("linux", {})).toBe("musl");
		expect(libcFamily("linux", undefined)).toBe("unknown");
		expect(libcFamily("darwin", {})).toBeUndefined();
		expect(libcFamily("win32", undefined)).toBeUndefined();
	});
});
