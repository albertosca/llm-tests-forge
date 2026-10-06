import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveForStryker } from "../../scripts/mutation/stryker-typescript-resolve.mjs";
import { REPOSITORY } from "../helpers/repository";

const STRYKER_PARENT = pathToFileURL(
	join(
		REPOSITORY,
		"node_modules/@stryker-mutator/typescript-checker/dist/src/typescript-checker.js",
	),
).href;
const PROJECT_PARENT = pathToFileURL(
	join(REPOSITORY, "src/core/files.ts"),
).href;

/** What the hook hands on to Node's own resolution. */
function resolvedAs(specifier: string, parentURL: string | undefined): string {
	return resolveForStryker(
		specifier,
		{ parentURL },
		(nextSpecifier) => nextSpecifier,
	);
}

describe("the resolve hook Stryker's processes load", () => {
	test("inside @stryker-mutator, `typescript` is TypeScript 5's alias, so the JS API it calls exists", () => {
		expect(resolvedAs("typescript", STRYKER_PARENT)).toBe("typescript5");
	});

	test("inside @stryker-mutator, the native compiler's alias is the project's own TypeScript, entry kept", () => {
		expect(resolvedAs("@typescript/native/unstable/sync", STRYKER_PARENT)).toBe(
			"typescript/unstable/sync",
		);
	});

	test("inside @stryker-mutator, any other import, `typescript/...` included, is left alone", () => {
		expect(resolvedAs("semver", STRYKER_PARENT)).toBe("semver");
		expect(resolvedAs("typescript/unstable/sync", STRYKER_PARENT)).toBe(
			"typescript/unstable/sync",
		);
		expect(resolvedAs("typescript5", STRYKER_PARENT)).toBe("typescript5");
	});

	test("outside @stryker-mutator, and for an entry point with no parent, nothing is redirected", () => {
		expect(resolvedAs("typescript", PROJECT_PARENT)).toBe("typescript");
		expect(resolvedAs("typescript", undefined)).toBe("typescript");
		expect(resolvedAs("@typescript/native/unstable/sync", PROJECT_PARENT)).toBe(
			"@typescript/native/unstable/sync",
		);
	});
});

const PackageSchema = z.object({
	version: z.string(),
	exports: z.record(z.string(), z.unknown()).optional(),
});

function installedPackage(name: string): z.infer<typeof PackageSchema> {
	return PackageSchema.parse(
		JSON.parse(
			readFileSync(
				join(REPOSITORY, "node_modules", name, "package.json"),
				"utf8",
			),
		),
	);
}

describe("the two TypeScripts the hook points at", () => {
	test("`typescript5` is a TypeScript 5, and `typescript` a 7 that exports the sync API the native checker loads", () => {
		expect(installedPackage("typescript5").version).toStartWith("5.");
		const project = installedPackage("typescript");
		expect(project.version).toStartWith("7.");
		expect(Object.keys(project.exports ?? {})).toContain("./unstable/sync");
	});

	test("`tsc` on the PATH of a package script is TypeScript 7's, not the alias's", () => {
		const tsc = Bun.spawnSync(["bun", "run", "--silent", "tsc", "--version"], {
			cwd: REPOSITORY,
		});
		expect(tsc.stdout.toString()).toStartWith("Version 7.");
		expect(tsc.exitCode).toBe(0);
	}, 30_000);
});
