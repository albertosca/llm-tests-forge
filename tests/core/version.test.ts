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
		expect(compareVersions("not-a-version", "0.4.1")).toBe("older");
	});
	test("a prerelease is below its release: a difference in the same release line, never older or newer by minor", () => {
		expect(compareVersions("0.1.0-beta.1", "0.1.0")).toBe("patch");
		expect(compareVersions("0.1.0", "0.1.0-beta.1")).toBe("patch");
		expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.1")).toBe("same");
		expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.2")).toBe("patch");
		expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.1")).toBe("patch");
	});
	test("a prerelease still orders by major and minor against other releases", () => {
		expect(compareVersions("0.1.0-beta.1", "0.0.9")).toBe("newer");
		expect(compareVersions("0.0.9", "0.1.0-beta.1")).toBe("older");
	});
	test("a newer patch in the stamp is a patch difference, and a newer minor is newer", () => {
		expect(compareVersions("0.4.2", "0.4.1")).toBe("patch");
		expect(compareVersions("0.5.0", "0.4.1")).toBe("newer");
	});
	test("build metadata is parsed and ignored (SemVer 2.0.0 item 10)", () => {
		expect(compareVersions("0.1.0+build", "0.1.0")).toBe("same");
		expect(compareVersions("0.1.0", "0.1.0+build.7")).toBe("same");
		expect(compareVersions("0.1.0-beta.1+b5", "0.1.0-beta.1")).toBe("same");
		expect(compareVersions("0.1.0+001", "0.1.0+exp-sha.5114f85")).toBe("same");
		expect(compareVersions("0.2.0+build", "0.1.0")).toBe("newer");
	});
	test("a version outside the SemVer 2.0.0 grammar is unreadable: older, never newer, never same", () => {
		for (const invalid of [
			"0.1.0-01",
			"0.1.0-beta..1",
			"0.1.0-",
			"0.1.0-beta.",
			"0.1.0-.beta",
			"0.1.0-beta_1",
			"0.1.0+",
			"0.1.0+build..1",
			"0.1.0+build+again",
			"01.1.0",
			"0.01.0",
			"0.1.00",
			"v0.1.0",
			"0.1",
			"",
		]) {
			expect(compareVersions(invalid, "0.1.0")).toBe("older");
			expect(compareVersions("0.1.0", invalid)).toBe("older");
		}
	});
	test("numbers past Number.MAX_SAFE_INTEGER compare exactly, in the core and the prerelease", () => {
		expect(
			compareVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992"),
		).toBe("patch");
		expect(
			compareVersions("9007199254740993.0.0", "9007199254740992.0.0"),
		).toBe("newer");
		expect(
			compareVersions("0.9007199254740992.0", "0.9007199254740993.0"),
		).toBe("older");
		expect(
			compareVersions("0.0.9007199254740993", "0.0.9007199254740992"),
		).toBe("patch");
		expect(compareVersions("0.0.10", "0.0.9")).toBe("patch");
	});
	test("the identifiers SemVer 2.0.0 allows still parse", () => {
		expect(compareVersions("0.1.0-0", "0.1.0-0")).toBe("same");
		expect(compareVersions("0.1.0-0a", "0.1.0-0a")).toBe("same");
		expect(compareVersions("0.1.0-x-y.z--1", "0.1.0-x-y.z--1")).toBe("same");
		expect(compareVersions("0.1.0+01.a-b", "0.1.0")).toBe("same");
		expect(compareVersions("10.20.30", "10.20.30")).toBe("same");
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
	test("a release is higher than its prerelease and a prerelease is not; prereleases order by identifier", () => {
		expect(isHigherVersion("0.1.0", "0.1.0-beta.1")).toBe(true);
		expect(isHigherVersion("0.1.0-beta.1", "0.1.0")).toBe(false);
		expect(isHigherVersion("0.1.0-beta.1", "0.0.9")).toBe(true);
		expect(isHigherVersion("0.1.0-beta.2", "0.1.0-beta.1")).toBe(true);
		expect(isHigherVersion("0.1.0-beta.10", "0.1.0-beta.9")).toBe(true);
		expect(isHigherVersion("0.1.0-beta.1", "0.1.0-alpha.1")).toBe(true);
		expect(isHigherVersion("0.1.0-beta.1", "0.1.0-beta.1")).toBe(false);
		expect(isHigherVersion("0.1.0-beta.1", "0.1.0-beta")).toBe(true);
		expect(isHigherVersion("0.1.0-alpha", "0.1.0-1")).toBe(true);
		expect(isHigherVersion("0.1.0-1", "0.1.0-alpha")).toBe(false);
	});
	test("an unreadable existing stamp is replaceable and an unreadable candidate never wins", () => {
		expect(isHigherVersion("0.1.0", "garbage")).toBe(true);
		expect(isHigherVersion("garbage", "0.1.0")).toBe(false);
	});
	test("numbers past Number.MAX_SAFE_INTEGER order exactly, whichever way round", () => {
		for (const [higher, lower] of [
			["1.0.0-9007199254740993", "1.0.0-9007199254740992"],
			["9007199254740993.0.0", "9007199254740992.0.0"],
			["0.9007199254740993.0", "0.9007199254740992.0"],
			["0.0.9007199254740993", "0.0.9007199254740992"],
			["0.0.100000000000000000000", "0.0.99999999999999999999"],
			["1.0.0-alpha.100000000000000000000", "1.0.0-alpha.99999999999999999999"],
		] as const) {
			expect(isHigherVersion(higher, lower)).toBe(true);
			expect(isHigherVersion(lower, higher)).toBe(false);
		}
	});
	test("an invalid prerelease is never an upgrade, and build metadata never makes one", () => {
		for (const invalid of ["0.1.0-01", "0.1.0-beta..1", "0.1.0-"]) {
			expect(isHigherVersion(invalid, "0.0.1")).toBe(false);
			expect(isHigherVersion("0.0.1", invalid)).toBe(true);
		}
		expect(isHigherVersion("0.1.0+build.2", "0.1.0+build.1")).toBe(false);
		expect(isHigherVersion("0.1.0+build", "0.1.0")).toBe(false);
		expect(isHigherVersion("0.1.0", "0.1.0+build")).toBe(false);
		expect(isHigherVersion("0.1.1+build", "0.1.0")).toBe(true);
	});
	test("prerelease identifiers order in both directions: equal ones pass to the next, alphanumerics by ASCII, and any alphanumeric above any number", () => {
		for (const [higher, lower] of [
			// Equal numeric identifiers leave it to the next one.
			["1.0.0-1.2", "1.0.0-1.1"],
			// Alphanumerics compare in ASCII order, uppercase before lowercase.
			["1.0.0-beta", "1.0.0-alpha"],
			["1.0.0-alpha", "1.0.0-Beta"],
			// An alphanumeric is above a number, however long the number, and
			// whether it starts with a digit or a hyphen.
			["1.0.0-a", "1.0.0-12345"],
			["1.0.0-1a", "1.0.0-2"],
			["1.0.0--x", "1.0.0-1"],
		] as const) {
			expect({
				higher,
				lower,
				higherWins: isHigherVersion(higher, lower),
			}).toEqual({ higher, lower, higherWins: true });
			expect({
				higher,
				lower,
				lowerWins: isHigherVersion(lower, higher),
			}).toEqual({ higher, lower, lowerWins: false });
		}
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
	test("a difference in the prerelease or the patch never warns, whichever way it goes (the spec warns on major or minor alone)", () => {
		expect(versionWarning("0.1.1", "0.1.0")).toBeNull();
		expect(versionWarning("0.1.1-beta.1", "0.1.0")).toBeNull();
		expect(versionWarning("0.1.0", "0.1.0-beta.1")).toBeNull();
		expect(versionWarning("0.1.0-beta.2", "0.1.0-beta.1")).toBeNull();
		expect(versionWarning("0.1.0-beta.1", "0.1.0")).toBeNull();
	});
	test("a minor difference still warns when the stamp is a prerelease", () => {
		expect(versionWarning("0.2.0-beta.1", "0.1.0")).toBe(
			"warning: this suite was written by llm-tests-forge 0.2.0-beta.1, newer than the installed 0.1.0; upgrade llm-tests-forge before changing it",
		);
	});
	test("an empty stamp is absent: no warning", () => {
		expect(versionWarning("", "0.4.1")).toBeNull();
	});
});
