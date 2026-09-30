import { describe, expect, spyOn, test } from "bun:test";
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
	removeFile,
	rewriteSuiteInclude,
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
			expect((caught as Error).message).toBe(
				`permission denied (file: ${target})`,
			);
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
			throw Object.assign(new Error("ENOSPC: no space left on device"), {
				code: "ENOSPC",
			});
		};
		let caught: unknown;
		try {
			await writeText(path, "id: s-01\nstatus: rejected\n", {
				writeContent: dyingHalfWay,
			});
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

	test("a path that is a directory is refused before anything is written, as writing in place refused it", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await mkdir(join(path, "inside"), { recursive: true });
		await expect(writeText(path, "x: 1\n")).rejects.toThrow(
			`cannot write: EISDIR: illegal operation on a directory, open '${path}'`,
		);
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("a file the person made read-only is refused, not replaced by the rename", async () => {
		if (process.getuid?.() === 0) return;
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		await chmod(path, 0o444);
		await expect(writeText(path, "x: 1\n")).rejects.toThrow(
			`cannot write: EACCES: permission denied, open '${path}'`,
		);
		expect(await readFile(path, "utf8")).toBe(ORIGINAL);
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("in a directory that refuses new files, an existing file is still rewritten in place", async () => {
		if (process.getuid?.() === 0) return;
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		await chmod(directory, 0o555);
		try {
			await writeText(path, "x: 1\n");
		} finally {
			await chmod(directory, 0o755);
		}
		expect(await readFile(path, "utf8")).toBe("x: 1\n");
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("in a directory that refuses new files, a new file is refused", async () => {
		if (process.getuid?.() === 0) return;
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		await chmod(directory, 0o555);
		try {
			// The message names the file asked for, never the hidden
			// temporary file the refusal actually hit.
			const path = join(directory, "new.yaml");
			await expect(writeText(path, "x: 1\n")).rejects.toThrow(
				`cannot write: EACCES: permission denied, open '${path}' (file: ${path})`,
			);
		} finally {
			await chmod(directory, 0o755);
		}
		expect(await readdir(directory)).toEqual([]);
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

	test("the temporary file is never more readable than the file it replaces, from the moment it holds the text", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		await chmod(path, 0o600);
		const seen: number[] = [];
		await writeText(path, "x: 1\n", {
			afterTemporaryWritten: async (temporary) => {
				seen.push((await stat(temporary)).mode & 0o777);
			},
		});
		// Created with the umask's 0644, it held a 0600 file's full text,
		// readable by anyone, until the chmod.
		expect(seen).toEqual([0o600]);
	});

	test("a dangling symlink gets the file it points at created, relative to the link's own directory, as writing through it always did", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		await mkdir(join(root, "links"));
		await mkdir(join(root, "files"));
		const link = join(root, "links", "cases.yaml");
		await symlink(join("..", "files", "cases.yaml"), link);
		await writeText(link, "x: 1\n");
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readFile(join(root, "files", "cases.yaml"), "utf8")).toBe(
			"x: 1\n",
		);
		expect(await readdir(join(root, "links"))).toEqual(["cases.yaml"]);
	});

	test("a chain of symlinks is followed to the file at its end, and every link stays a link", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const real = join(directory, "real.yaml");
		await writeFile(real, ORIGINAL);
		await symlink("real.yaml", join(directory, "middle.yaml"));
		await symlink("middle.yaml", join(directory, "first.yaml"));
		await writeText(join(directory, "first.yaml"), "x: 1\n");
		expect(await readFile(real, "utf8")).toBe("x: 1\n");
		expect((await lstat(join(directory, "first.yaml"))).isSymbolicLink()).toBe(
			true,
		);
		expect((await lstat(join(directory, "middle.yaml"))).isSymbolicLink()).toBe(
			true,
		);
	});

	test("a symlink loop is refused by name instead of followed forever", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		await symlink("second.yaml", join(directory, "first.yaml"));
		await symlink("first.yaml", join(directory, "second.yaml"));
		const path = join(directory, "first.yaml");
		await expect(writeText(path, "x: 1\n")).rejects.toThrow(
			`cannot write: too many levels of symbolic links (file: ${path})`,
		);
	});

	test("a new file in a directory that does not exist yet is created, parents included", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases", "new.yaml");
		await writeText(path, "x: 1\n");
		expect(await readFile(path, "utf8")).toBe("x: 1\n");
		expect(await readdir(join(directory, "cases"))).toEqual(["new.yaml"]);
	});

	test("a failure after the temporary file holds the text is never retried in place: the file keeps its old text, and the message names both files as the OS did", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		let temporaryPath = "";
		// A rename the filesystem refuses once the text is safely in the
		// temporary file: writing in place now would give up all or nothing.
		const renameRefused = async (temporary: string) => {
			temporaryPath = temporary;
			throw Object.assign(
				new Error(
					`EACCES: permission denied, rename '${temporary}' -> '${path}'`,
				),
				{ code: "EACCES" },
			);
		};
		const caught = await writeText(path, "x: 1\n", {
			afterTemporaryWritten: renameRefused,
		}).catch((error: unknown) => error);
		expect((caught as ForgeError).message).toBe(
			`cannot write: EACCES: permission denied, rename '${temporaryPath}' -> '${path}' (file: ${path})`,
		);
		expect(await readFile(path, "utf8")).toBe(ORIGINAL);
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("a new file whose temporary copy is refused half-way is never written in place: nothing is left", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "new.yaml");
		const refusedHalfWay = async (target: string, text: string) => {
			await writeFile(target, text.slice(0, text.length / 2));
			throw Object.assign(new Error("EACCES: permission denied, write"), {
				code: "EACCES",
			});
		};
		await expect(
			writeText(path, "id: s-01\nstatus: rejected\n", {
				writeContent: refusedHalfWay,
			}),
		).rejects.toThrow(
			`cannot write: EACCES: permission denied, write (file: ${path})`,
		);
		expect(await readdir(directory)).toEqual([]);
	});

	test("a directory that refuses new files with EPERM, as some filesystems word it, still has its existing file rewritten in place", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		const newFilesRefused = async (
			target: string,
			text: string,
			mode: number | undefined,
		) => {
			if (target !== path)
				throw Object.assign(
					new Error(`EPERM: operation not permitted, open '${target}'`),
					{ code: "EPERM" },
				);
			await writeFile(target, text, { mode });
		};
		await writeText(path, "x: 1\n", { writeContent: newFilesRefused });
		expect(await readFile(path, "utf8")).toBe("x: 1\n");
		expect(await readdir(directory)).toEqual(["cases.yaml"]);
	});

	test("the replaced file keeps permissions the umask would have narrowed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-atomic-"));
		const path = join(directory, "cases.yaml");
		await writeFile(path, ORIGINAL);
		await chmod(path, 0o666);
		const previousUmask = process.umask(0o022);
		try {
			await writeText(path, "x: 1\n");
		} finally {
			process.umask(previousUmask);
		}
		expect((await stat(path)).mode & 0o777).toBe(0o666);
	});
});

describe("readFailure: every cause in the person's words", () => {
	test("EACCES and EPERM both read as permission denied, whatever the OS message says", () => {
		expect(
			readFailure(
				Object.assign(new Error("EACCES: permission denied, open 'a'"), {
					code: "EACCES",
				}),
			),
		).toBe("permission denied");
		expect(
			readFailure(
				Object.assign(new Error("EPERM: operation not permitted, open 'a'"), {
					code: "EPERM",
				}),
			),
		).toBe("permission denied");
	});

	test("a thrown value that is not an Error is quoted as it is, never read as undefined", () => {
		expect(readFailure("the disk went away")).toBe(
			"cannot read: the disk went away",
		);
		expect(readFailure(null)).toBe("cannot read: null");
	});
});

describe("readYamlFile: every problem in a list is named", () => {
	test("an item with an id is named by it with the path inside it, one with none by its index, one after another", async () => {
		const forgeDirectory = await tmpForge();
		await mkdir(join(forgeDirectory, "cases"), { recursive: true });
		const path = join(forgeDirectory, "cases", "c.yaml");
		await writeFile(
			path,
			"- id: c-01\n  scenario: c\n  input: {email: 3}\n  expected: {label: a, rubric: b}\n  status: pending\n  generated_by: t\n-\n- just text\n",
		);
		await expect(readCases(forgeDirectory, "c")).rejects.toThrow(
			`does not match schema: item "c-01" (index 0).input.email: Invalid input: expected string, received number; item "c-01" (index 0).expected: expected must carry exactly one of label, fields, rubric; 1: Invalid input: expected object, received null; 2: Invalid input: expected object, received string (file: ${path})`,
		);
	});

	test("an item whose id is not text is named by its index, never by that id", async () => {
		const forgeDirectory = await tmpForge();
		await mkdir(forgeDirectory, { recursive: true });
		const path = forgePaths(forgeDirectory).scenarios;
		await writeFile(
			path,
			"- id: 7\n  kind: happy\n  oracle: label\n  description: a\n  status: weird\n",
		);
		await expect(readScenarios(forgeDirectory)).rejects.toThrow(
			`does not match schema: 0.id: Invalid input: expected string, received number; 0.status: Invalid option: expected one of "pending"|"approved"|"rejected"|"edited" (file: ${path})`,
		);
	});
});

describe("files the forge writes and lists", () => {
	test("a long description is written on one line, never folded", async () => {
		const forgeDirectory = await tmpForge();
		const description = `A reply that ${"politely ".repeat(12)}declines the offer.`;
		await writeScenarios(forgeDirectory, [
			{
				id: "s",
				kind: "happy",
				oracle: "label",
				description,
				status: "pending",
			},
		]);
		expect(
			await readFile(forgePaths(forgeDirectory).scenarios, "utf8"),
		).toContain(`  description: ${description}\n`);
	});

	test("only .yaml files in cases/ are scenarios: notes and a left-over temporary file are not", async () => {
		const forgeDirectory = await tmpForge();
		const casesDirectory = forgePaths(forgeDirectory).casesDir;
		await mkdir(casesDirectory, { recursive: true });
		for (const name of [
			"b.yaml",
			"notes.txt",
			".forge-write-0000.tmp",
			"a.yaml",
		])
			await writeFile(join(casesDirectory, name), "[]\n");
		expect(await listCaseScenarios(forgeDirectory)).toStrictEqual(["a", "b"]);
	});

	test("a cases file's fingerprint is its size and last modification time", async () => {
		const forgeDirectory = await tmpForge();
		await writeCases(forgeDirectory, "s", []);
		const information = await stat(
			join(forgePaths(forgeDirectory).casesDir, "s.yaml"),
		);
		expect(await caseFileFingerprint(forgeDirectory, "s")).toStrictEqual({
			modifiedAtInMilliseconds: information.mtimeMs,
			sizeInBytes: information.size,
		});
	});

	test("the suite example shown when there is none reads in full", () => {
		expect(suiteExample(undefined)).toBe(
			[
				"target:",
				"  kind: python                    # python | javascript | typescript | elixir | ruby | rust | go | exec | http",
				"  entry: forge_target.py          # optional: the shim emit writes next to this file",
				"  python: .venv/bin/python        # optional: interpreter that can import your application",
				"  models: [anthropic/claude-haiku-4-5]",
				"judges: [google/gemini-3.5-flash]",
				"repeat: 2",
				"include: []                       # scenario ids; empty means every approved scenario",
			].join("\n"),
		);
	});
});

describe("removeFile", () => {
	test("removes the file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-remove-"));
		await writeFile(join(directory, "old.yaml"), "[]\n");
		await removeFile(join(directory, "old.yaml"), "nothing else to do");
		expect(await readdir(directory)).toEqual([]);
	});

	test("a removal that fails names the file, the OS's reason and what is left to do by hand", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-remove-"));
		const path = join(directory, "old.yaml");
		await expect(
			removeFile(path, "new.yaml is already written; delete old.yaml by hand"),
		).rejects.toThrow(
			`cannot remove: ENOENT: no such file or directory, unlink '${path}'; new.yaml is already written; delete old.yaml by hand (file: ${path})`,
		);
	});
});

describe("rewriteSuiteInclude", () => {
	const SUITE = `# my suite
target:
  kind: python
  models: [anthropic/claude-haiku-4-5]
judges: [google/gemini-3.5-flash]
include: [old, keep, old] # the ones that matter
`;

	test("every entry naming the scenario is renamed, the rest of the file as written", () => {
		expect(
			rewriteSuiteInclude({
				path: "suite.yaml",
				text: SUITE,
				from: "old",
				to: "new",
				occurrences: 2,
			}),
		).toBe(SUITE.replace("[old, keep, old]", "[new, keep, new]"));
	});

	test("an entry reached through an alias is refused by name, not reported as renamed", () => {
		expect(() =>
			rewriteSuiteInclude({
				path: "suite.yaml",
				text: `${SUITE.replace("judges: [google/gemini-3.5-flash]", "judges: [&first old]").replace("[old, keep, old]", "[*first, keep, old]")}`,
				from: "old",
				to: "new",
				occurrences: 2,
			}),
		).toThrow(
			'suite.include names "old" 2 time(s) but only 1 can be rewritten in place: the rest come through a YAML alias; edit suite.yaml by hand (file: suite.yaml, id: old)',
		);
	});
});

describe("stampSuite, in the files people write", () => {
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

	test("a suite with no stamp gets the installed version, even one outside semver, and its kind is left as it is", async () => {
		const { forgeDirectory, path } = await suiteWith(
			"target:\n  kind: typescript\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n",
		);
		expect(await stampSuite(forgeDirectory, "0.4")).toBe(true);
		expect(await readFile(path, "utf8")).toBe(
			'forge_version: "0.4"\ntarget:\n  kind: typescript\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n',
		);
	});

	test("a forge_version that aliases another value is replaced by the stamp, and the anchor stays", async () => {
		const text =
			"target:\n  kind: python\n  entry: &entry forge_target.py\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\nforge_version: *entry\n";
		const { forgeDirectory, path } = await suiteWith(text);
		expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
		expect(await readFile(path, "utf8")).toBe(
			text.replace("forge_version: *entry", "forge_version: 0.4.1"),
		);
	});

	test("a header comment stays at the top of the file, above the stamp, whatever shape the first key has", async () => {
		// A key that is a list is legal YAML; reading it, the yaml library
		// warns that it stringifies the key, which is noise here.
		const warning = spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const { forgeDirectory, path } = await suiteWith(
				"# my suite\n? [odd, key]\n: 1\ntarget:\n  kind: python\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n",
			);
			expect(await stampSuite(forgeDirectory, "0.4.1")).toBe(true);
			expect(await readFile(path, "utf8")).toBe(
				"# my suite\nforge_version: 0.4.1\n? [odd, key]\n: 1\ntarget:\n  kind: python\n  models: [anthropic/claude-haiku-4-5]\njudges: [google/gemini-3.5-flash]\n",
			);
		} finally {
			warning.mockRestore();
		}
	});
});
