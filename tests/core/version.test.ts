import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	compareVersions,
	FORGE_VERSION,
	isHigherVersion,
	versionWarning,
} from "../../src/core/version";

describe("FORGE_VERSION", () => {
	test("is package.json's version", async () => {
		const packageJson = JSON.parse(await readFile("package.json", "utf8"));
		expect(FORGE_VERSION).toBe(packageJson.version);
	});
});

describe("compareVersions", () => {
	test("orders by major and minor, and a patch difference is its own answer", () => {
		expect(compareVersions("0.4.1", "0.4.1")).toBe("same");
		expect(compareVersions("0.4.0", "0.4.1")).toBe("patch");
		expect(compareVersions("0.3.9", "0.4.1")).toBe("older");
		expect(compareVersions("1.0.0", "0.9.0")).toBe("newer");
		expect(compareVersions("0.4.1-beta.1", "0.4.1")).toBe("same");
		expect(compareVersions("not-a-version", "0.4.1")).toBe("older");
	});
	test("a newer patch in the stamp is a patch difference, and a newer minor is newer", () => {
		expect(compareVersions("0.4.2", "0.4.1")).toBe("patch");
		expect(compareVersions("0.5.0", "0.4.1")).toBe("newer");
	});
});

describe("isHigherVersion", () => {
	test("compares major, minor and patch in that order; equal is not higher", () => {
		expect(isHigherVersion("1.0.0", "0.9.9")).toBe(true);
		expect(isHigherVersion("0.5.0", "0.4.9")).toBe(true);
		expect(isHigherVersion("0.4.2", "0.4.1")).toBe(true);
		expect(isHigherVersion("0.4.1", "0.4.2")).toBe(false);
		expect(isHigherVersion("0.4.1", "0.4.1")).toBe(false);
		expect(isHigherVersion("0.4.1-beta.1", "0.4.1")).toBe(false);
	});
	test("an unreadable existing stamp is replaceable and an unreadable candidate never wins", () => {
		expect(isHigherVersion("0.1.0", "garbage")).toBe(true);
		expect(isHigherVersion("garbage", "0.1.0")).toBe(false);
	});
});

describe("versionWarning", () => {
	test("silent for a missing stamp, the same version or a patch; says the stamp for an older one; says to upgrade for a newer one", () => {
		expect(versionWarning(undefined, "0.4.1")).toBeNull();
		expect(versionWarning("0.4.0", "0.4.1")).toBeNull();
		expect(versionWarning("0.3.0", "0.4.1")).toBe(
			"warning: this suite was written by llm-tests-forge 0.3.0; installed is 0.4.1",
		);
		expect(versionWarning("0.5.0", "0.4.1")).toBe(
			"warning: this suite was written by llm-tests-forge 0.5.0, newer than the installed 0.4.1; upgrade llm-tests-forge before changing it",
		);
	});
});
