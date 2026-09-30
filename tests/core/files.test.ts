import { describe, expect, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import {
	caseFileFingerprint,
	forgePaths,
	listCaseScenarios,
	readAllCases,
	readCaseFile,
	readCases,
	readFailure,
	readFeature,
	readScenarios,
	readSuite,
	readYamlFile,
	stampSuite,
	suiteExample,
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
	writeText,
} from "../../src/core/files";
import type { Case, Scenario } from "../../src/core/schemas";
import { LANGUAGES, SuiteSchema } from "../../src/core/schemas";

async function tmpForge(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-"));
	return join(directory, ".forge");
}

describe("forgePaths", () => {
	test("derives every path from the forge dir", () => {
		const paths = forgePaths("/x/.forge");
		expect(paths.feature).toBe("/x/.forge/feature.yaml");
		expect(paths.scenarios).toBe("/x/.forge/scenarios.yaml");
		expect(paths.casesDir).toBe("/x/.forge/cases");
		expect(paths.suite).toBe("/x/.forge/suite.yaml");
		expect(paths.usage).toBe("/x/.forge/usage.jsonl");
		expect(paths.failuresDir).toBe("/x/.forge/failures");
	});
});

describe("feature round trip", () => {
	test("write then read returns the same object and creates the directory", async () => {
		const directory = await tmpForge();
		const fixture = await readFile(
			join(import.meta.dir, "../fixtures/feature.yaml"),
			"utf8",
		);
		const { parse } = await import("yaml");
		const feature = parse(fixture);
		await writeFeature(directory, feature);
		expect(await readFeature(directory)).toEqual(feature);
	});

	test("invalid file throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: only-an-id\n");
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("does not match schema");
		expect((caught as ForgeError).message).toContain("feature.yaml");
	});

	test("missing file throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("file not found");
		expect((caught as ForgeError).message).toContain("feature.yaml");
		expect((caught as ForgeError).details.file).toBe(
			forgePaths(directory).feature,
		);
	});

	test("malformed YAML syntax throws ForgeError naming the file", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: [unterminated\n");
		const caught = await readFeature(directory).catch(
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain("invalid YAML");
		expect((caught as ForgeError).message).toContain("feature.yaml");
	});
});

describe("scenarios and cases", () => {
	test("missing files read as empty lists", async () => {
		const directory = await tmpForge();
		expect(await readScenarios(directory)).toEqual([]);
		expect(await readCases(directory, "nope")).toEqual([]);
		expect(await listCaseScenarios(directory)).toEqual([]);
	});

	test("round trip and listing sorted by scenario id", async () => {
		const directory = await tmpForge();
		const scenarios: Scenario[] = [
			{
				id: "b-scn",
				kind: "happy",
				oracle: "label",
				description: "b",
				status: "pending",
			},
		];
		await writeScenarios(directory, scenarios);
		expect(await readScenarios(directory)).toEqual(scenarios);
		const cases: Case[] = [
			{
				id: "b-scn-01",
				scenario: "b-scn",
				input: { email: "hi" },
				expected: { label: "x" },
				status: "pending",
				generated_by: "t",
			},
		];
		await writeCases(directory, "b-scn", cases);
		await writeCases(
			directory,
			"a-scn",
			cases.map((caseEntry) => ({
				...caseEntry,
				id: "a-scn-01",
				scenario: "a-scn",
			})),
		);
		expect(await readCases(directory, "b-scn")).toEqual(cases);
		expect(await listCaseScenarios(directory)).toEqual(["a-scn", "b-scn"]);
	});
});

describe("readCaseFile", () => {
	test("a cases file that does not exist reads as null, not as an empty list with no fingerprint", async () => {
		const forgeDirectory = await tmpForge();
		expect(await readCaseFile(forgeDirectory, "absent")).toBeNull();
	});
	test("an existing cases file reads as its cases together with the fingerprint of that file", async () => {
		const forgeDirectory = await tmpForge();
		const cases: Case[] = [
			{
				id: "present-01",
				scenario: "present",
				input: { email: "hi" },
				expected: { label: "x" },
				status: "pending",
				generated_by: "hand",
			},
		];
		await writeCases(forgeDirectory, "present", cases);
		const fingerprint = await caseFileFingerprint(forgeDirectory, "present");
		if (fingerprint === null) throw new Error("the file was just written");
		expect(await readCaseFile(forgeDirectory, "present")).toEqual({
			cases,
			fingerprint,
		});
	});
});

describe("forgePaths: plan 2 entries", () => {
	test("names the emitted config, the JSONL export and both report files under .forge", () => {
		const paths = forgePaths("/x/.forge");
		expect(paths.promptfooConfig).toBe("/x/.forge/promptfooconfig.yaml");
		expect(paths.casesJsonl).toBe("/x/.forge/cases.jsonl");
		expect(paths.reportMd).toBe("/x/.forge/report.md");
		expect(paths.reportJson).toBe("/x/.forge/report.json");
	});
});

describe("suite.yaml", () => {
	const suite = {
		target: {
			kind: "python" as const,
			entry: "forge_target.py",
			models: ["anthropic/claude-haiku-4-5"],
		},
		judges: ["google/gemini-3.5-flash"],
		repeat: 2,
		include: [],
	};
	test("round-trips through writeSuite/readSuite", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		await writeSuite(directory, suite);
		expect(await readSuite(directory)).toEqual(suite);
	});
	test("readSuite on a missing file names the path and prints an example to copy", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		const caught = await readSuite(directory).catch((error: Error) => error);
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as Error).message).toContain(join(directory, "suite.yaml"));
		expect((caught as Error).message).toContain("target:");
		expect((caught as Error).message).toContain("judges:");
	});
	test("readSuite's example uses the project's language when it is given one", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		const caught = await readSuite(directory, "ruby").catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain(suiteExample("ruby"));
	});
	test("suiteExample: the language's kind and default entry, python for none or other, and every example parses as a suite", () => {
		expect(suiteExample("elixir").split("\n").slice(0, 3)).toEqual([
			"target:",
			"  kind: elixir                    # python | javascript | typescript | elixir | ruby | rust | go | exec | http",
			"  entry: forge_target.exs         # optional: the shim emit writes next to this file",
		]);
		expect(suiteExample("elixir")).not.toContain("python: .venv/bin/python");
		for (const language of [undefined, "other"] as const) {
			expect(suiteExample(language)).toContain("  kind: python ");
			expect(suiteExample(language)).toContain(
				"  python: .venv/bin/python        # optional: interpreter that can import your application",
			);
		}
		for (const language of LANGUAGES) {
			const parsed = SuiteSchema.parse(parse(suiteExample(language)));
			expect(parsed.target.kind).toBe(
				language === "other" ? "python" : language,
			);
		}
	});
});

describe("readAllCases", () => {
	test("returns one entry per cases file, keyed by scenario id, in sorted order", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		const makeCase = (id: string, scenario: string) => ({
			id,
			scenario,
			input: { email: id },
			status: "approved" as const,
			generated_by: "t",
		});
		await writeCases(directory, "zeta", [makeCase("zeta-01", "zeta")]);
		await writeCases(directory, "alpha", [
			makeCase("alpha-01", "alpha"),
			makeCase("alpha-02", "alpha"),
		]);
		const all = await readAllCases(directory);
		expect([...all.keys()]).toEqual(["alpha", "zeta"]);
		expect(all.get("alpha")?.map((caseEntry) => caseEntry.id)).toEqual([
			"alpha-01",
			"alpha-02",
		]);
		expect(all.get("zeta")?.map((caseEntry) => caseEntry.id)).toEqual([
			"zeta-01",
		]);
	});
	test("is empty when there is no cases directory", async () => {
		const directory = join(
			await mkdtemp(join(tmpdir(), "forge-files-")),
			".forge",
		);
		expect((await readAllCases(directory)).size).toBe(0);
	});
});

describe("readYamlFile: array schema errors name the element, not just the path", () => {
	test("an issue on an array item with a string id reports the id and the index", async () => {
		const directory = await tmpForge();
		await mkdir(directory, { recursive: true });
		await writeFile(
			forgePaths(directory).scenarios,
			`- id: first-id
  kind: happy
  oracle: label
  description: a
  status: pending
- id: second-id
  kind: happy
  oracle: label
  description: b
  status: pending
- id: third-id
  kind: happy
  oracle: bogus
  description: c
  status: pending
`,
		);
		const caught = await readScenarios(directory).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain(
			'item "third-id" (index 2).oracle:',
		);
		expect((caught as Error).message).toContain(
			forgePaths(directory).scenarios,
		);
	});
	test("an issue on an array item with no string id keeps the plain index.field form", async () => {
		const directory = await tmpForge();
		await mkdir(directory, { recursive: true });
		await writeFile(
			forgePaths(directory).scenarios,
			`- id: first-id
  kind: happy
  oracle: label
  description: a
  status: pending
- id: second-id
  kind: happy
  oracle: label
  description: b
  status: pending
- kind: happy
  oracle: bogus
  description: c
  status: pending
`,
		);
		const caught = await readScenarios(directory).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain("2.oracle: Invalid option");
		expect((caught as Error).message).not.toContain('item "');
		expect((caught as Error).message).toContain(
			forgePaths(directory).scenarios,
		);
	});
	test("a schema error on a non-array file keeps the plain 'field: message' form", async () => {
		const directory = await tmpForge();
		await writeFeature(directory, {
			id: "a",
			purpose: "b",
			inputs: [{ name: "x", kind: "text" }],
			output: { kind: "text" },
			invariants: [],
			status: "pending",
		});
		await writeFile(forgePaths(directory).feature, "id: only-an-id\n");
		const caught = await readFeature(directory).catch((error: Error) => error);
		expect((caught as Error).message).toContain("purpose: Invalid input");
	});
});

describe("readYamlFile: the real cause of a read failure", () => {
	test("a directory where a file was expected says so, not 'file not found'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const target = join(directory, "suite.yaml");
		await mkdir(target);
		const caught = await readYamlFile(target, SuiteSchema).catch(
			(error: Error) => error,
		);
		expect((caught as Error).message).toContain("is a directory");
		expect((caught as Error).message).not.toContain("not found");
	});
	// Skipped as root (e.g. some CI/container setups): root ignores the
	// 0o000 permission bits and the read succeeds instead of failing with
	// EACCES, which would make this assertion meaningless there.
	test.skipIf(process.getuid?.() === 0)(
		"an unreadable file says 'permission denied'",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
			const target = join(directory, "suite.yaml");
			await writeFile(target, "target: {}");
			await chmod(target, 0o000);
			const caught = await readYamlFile(target, SuiteSchema).catch(
				(error: Error) => error,
			);
			await chmod(target, 0o600);
			expect((caught as Error).message).toContain("permission denied");
		},
	);
	test("a missing file still says 'file not found'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const caught = await readYamlFile(
			join(directory, "nope.yaml"),
			SuiteSchema,
		).catch((error: Error) => error);
		expect((caught as Error).message).toContain("file not found");
	});
	test("an error with no code at all (not from fs) falls through to 'cannot read: <message>'", () => {
		expect(readFailure(new Error("boom"))).toBe("cannot read: boom");
	});
	test("an OS error with no special-cased code (ENOTDIR) falls through to 'cannot read: <message>'", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-files-"));
		const fileNotDirectory = join(directory, "afile");
		await writeFile(fileNotDirectory, "hi");
		const target = join(fileNotDirectory, "child.yaml");
		const rawError = await readFile(target, "utf8").catch(
			(error: Error) => error,
		);
		const caught = await readYamlFile(target, SuiteSchema).catch(
			(error: Error) => error,
		);
		expect((rawError as NodeJS.ErrnoException).code).toBe("ENOTDIR");
		expect((caught as Error).message).toBe(
			`cannot read: ${(rawError as Error).message} (file: ${target})`,
		);
	});
});

describe("stampSuite", () => {
	async function suiteWith(text: string): Promise<{
		forgeDirectory: string;
		path: string;
	}> {
		const forgeDirectory = await tmpForge();
		await mkdir(forgeDirectory, { recursive: true });
		const path = join(forgeDirectory, "suite.yaml");
		await writeFile(path, text);
		return { forgeDirectory, path };
	}
	const LEGACY = `target:
  kind: promptfoo-python
  entry: forge_target.py
  python: .venv/bin/python # the run's own interpreter
  models: [anthropic/claude-haiku-4-5]
judges: [google/gemini-3.5-flash]
`;

	test("keeps comments, turns promptfoo-python into python, sets forge_version, and says it wrote", async () => {
		const { forgeDirectory, path } = await suiteWith(LEGACY);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		const text = await readFile(path, "utf8");
		expect(text).toContain("# the run's own interpreter");
		expect(text).toContain("kind: python\n");
		expect(text).not.toContain("promptfoo-python");
		expect(text).toContain("forge_version: 0.4.1");
		expect((await readSuite(forgeDirectory)).forge_version).toBe("0.4.1");
	});
	test("a second stamp with the same version writes nothing and returns false", async () => {
		const { forgeDirectory, path } = await suiteWith(LEGACY);
		await stampSuite(forgeDirectory, "0.4.1");
		const before = await readFile(path, "utf8");
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(false);
		expect(await readFile(path, "utf8")).toBe(before);
	});
	test("never lowers a stamp: a suite stamped 0.5.0 stays 0.5.0 under 0.4.1", async () => {
		const { forgeDirectory, path } = await suiteWith(
			`forge_version: 0.5.0\n${LEGACY}`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		const text = await readFile(path, "utf8");
		expect(text).toContain("forge_version: 0.5.0");
		expect(text).not.toContain("0.4.1");
		expect(text).toContain("kind: python\n");
	});
	test("a higher patch in the stamp is kept too", async () => {
		const { forgeDirectory } = await suiteWith(
			`forge_version: 0.4.2\n${LEGACY}`,
		);
		await stampSuite(forgeDirectory, "0.4.1");
		expect((await readSuite(forgeDirectory)).forge_version).toBe("0.4.2");
	});
	test("a higher stamp on a suite with nothing to normalise writes nothing and returns false", async () => {
		const text = `forge_version: 0.5.0\n${LEGACY.replace("promptfoo-python", "python")}`;
		const { forgeDirectory, path } = await suiteWith(text);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(false);
		expect(await readFile(path, "utf8")).toBe(text);
	});
	test("raises an older stamp", async () => {
		const { forgeDirectory } = await suiteWith(
			`forge_version: 0.3.0\n${LEGACY}`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect((await readSuite(forgeDirectory)).forge_version).toBe("0.4.1");
	});
	test("a stamp that is not a version is replaced", async () => {
		const { forgeDirectory } = await suiteWith(
			`forge_version: garbage\n${LEGACY}`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect((await readSuite(forgeDirectory)).forge_version).toBe("0.4.1");
	});
	test("a suite with no kind to normalise and no stamp is only stamped", async () => {
		const { forgeDirectory, path } = await suiteWith(
			LEGACY.replace("promptfoo-python", "python"),
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect(await readFile(path, "utf8")).toContain("forge_version: 0.4.1");
	});
	test("a suite already stamped and normalised but for the kind is rewritten", async () => {
		const { forgeDirectory } = await suiteWith(
			`forge_version: 0.4.1\n${LEGACY}`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect((await readSuite(forgeDirectory)).target.kind).toBe("python");
	});
	test("a suite stamped 0.1.0-beta.1 is promoted to 0.1.0", async () => {
		const { forgeDirectory } = await suiteWith(
			`forge_version: 0.1.0-beta.1\n${LEGACY}`,
		);
		expect(await stampSuite(forgeDirectory, "0.1.0")).toBe(true);
		expect((await readSuite(forgeDirectory)).forge_version).toBe("0.1.0");
	});
	test("a suite stamped 0.1.0 keeps it under installed 0.1.0-beta.1", async () => {
		const text = `forge_version: 0.1.0\n${LEGACY.replace("promptfoo-python", "python")}`;
		const { forgeDirectory, path } = await suiteWith(text);
		expect(await stampSuite(forgeDirectory, "0.1.0-beta.1")).toBe(false);
		expect(await readFile(path, "utf8")).toBe(text);
	});
	test("an empty forge_version is stamped in place by the next write", async () => {
		const { forgeDirectory, path } = await suiteWith(
			`judges: [google/gemini-3.5-flash]\nforge_version: ""\ntarget:\n  kind: python\n  entry: forge_target.py\n  models: [anthropic/claude-haiku-4-5]\n`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect(await readFile(path, "utf8")).toBe(
			`judges: [google/gemini-3.5-flash]\nforge_version: 0.4.1\ntarget:\n  kind: python\n  entry: forge_target.py\n  models: [anthropic/claude-haiku-4-5]\n`,
		);
	});
	test("a forge_version added for the first time goes first in the file, and a later stamp keeps its place", async () => {
		const { forgeDirectory, path } = await suiteWith(
			`# my suite\ntarget:\n  kind: python\n  entry: forge_target.py\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		const stamped = await readFile(path, "utf8");
		expect(stamped).toBe(
			`# my suite\nforge_version: 0.4.1\ntarget:\n  kind: python\n  entry: forge_target.py\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n`,
		);
		expect(await stampSuite(forgeDirectory, "0.4.2")).toBe(true);
		expect(await readFile(path, "utf8")).toBe(
			stamped.replace("forge_version: 0.4.1", "forge_version: 0.4.2"),
		);
	});
	test("without a suite.yaml it returns false and creates no file", async () => {
		const forgeDirectory = await tmpForge();
		await mkdir(forgeDirectory, { recursive: true });
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(false);
		expect(await readdir(forgeDirectory)).toEqual([]);
	});
});

describe("writeText: a write is all or nothing", () => {
	const ORIGINAL = "id: s-01\nstatus: approved\n# a comment the person wrote\n";

	test("a write that fails half-way leaves the original byte-identical and no temporary file behind", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		// Writes half of the new text to wherever it is pointed, then dies —
		// a full disk, a killed process. Pointed at the file itself, it left
		// half a file behind.
		const dyingHalfWay = async (target: string, text: string) => {
			await writeFile(target, text.slice(0, text.length / 2));
			throw new Error("ENOSPC: no space left on device");
		};
		let caught: unknown;
		try {
			await writeText(path, "id: s-01\nstatus: rejected\n", dyingHalfWay);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			`cannot write: ENOSPC: no space left on device (file: ${path})`,
		);
		expect(await readFile(path, "utf8")).toBe(ORIGINAL);
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("a replace that cannot land (the path is a non-empty directory) removes its temporary file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await mkdir(join(path, "inside"), { recursive: true });
		await expect(writeText(path, "x: 1\n")).rejects.toThrow("cannot write:");
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("the replaced file keeps its permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		await chmod(path, 0o600);
		await writeText(path, "x: 1\n");
		expect(await readFile(path, "utf8")).toBe("x: 1\n");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	test("a file reached through a symlink is replaced where it lives, and the link stays a link", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const real = join(directory, "real.yaml");
		const link = join(directory, "link.yaml");
		await writeFile(real, ORIGINAL);
		await symlink(real, link);
		await writeText(link, "x: 1\n");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readFile(real, "utf8")).toBe("x: 1\n");
		expect((await readdir(directory)).sort()).toEqual([
			"link.yaml",
			"real.yaml",
		]);
	});

	test("a new file in a directory that does not exist yet is created, parents included", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases", "new.yaml");
		await writeText(path, "x: 1\n");
		expect(await readFile(path, "utf8")).toBe("x: 1\n");
		expect(await readdir(join(directory, "cases"))).toEqual(["new.yaml"]);
	});
});
