import { describe, expect, test } from "bun:test";
import {
	platformPackage,
	unsupportedMessage,
} from "../../packages/npm/main/bin/platform";
import { RELEASE_TARGETS } from "../../scripts/release/targets";

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
	});
});
