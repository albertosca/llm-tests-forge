import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
	checkRegisteredText,
	findProjectRoot,
	projectFileText,
	readProject,
	registeredSuiteNames,
	registerSuite,
	registrationHint,
} from "../../src/core/project";
import { projectWith } from "../helpers/project";

// The null case needs a parent with no forge.yaml anywhere above it; a machine
// that has one (a forge.yaml in the home directory or /tmp) cannot prove it.
const sandbox = await mkdtemp(join(tmpdir(), "forge-sandbox-"));
const machineHasProjectFileAbove = (await findProjectRoot(sandbox)) !== null;

// Two spellings of one directory exist only where the filesystem folds case
// (macOS and Windows by default); elsewhere they are two directories.
await mkdir(join(sandbox, "CaseProbe"));
const filesystemFoldsCase = await stat(join(sandbox, "caseprobe")).then(
	() => true,
	() => false,
);

describe("forge.yaml", () => {
	test("findProjectRoot walks up to the nearest forge.yaml", async () => {
		const parent = await mkdtemp(join(sandbox, "walk-"));
		const root = join(parent, "root");
		await mkdir(join(root, "evals", "a", "deep"), { recursive: true });
		await writeFile(join(root, "forge.yaml"), projectFileText("python"));
		expect(await findProjectRoot(join(root, "evals", "a", "deep"))).toBe(root);
	});
	test.skipIf(machineHasProjectFileAbove)(
		"findProjectRoot returns null from a sibling of a root, under a parent with no forge.yaml above it (skipped when this machine has a forge.yaml above the temporary directory)",
		async () => {
			const parent = await mkdtemp(join(sandbox, "sibling-"));
			await mkdir(join(parent, "root"));
			await writeFile(
				join(parent, "root", "forge.yaml"),
				projectFileText("python"),
			);
			await mkdir(join(parent, "sibling", "deep"), { recursive: true });
			expect(await findProjectRoot(join(parent, "sibling", "deep"))).toBeNull();
		},
	);
	test("the registration hint offers only forms that parse: the flow form on init's own file, the block line on a block list", async () => {
		const hint = registrationHint("evals/classify");
		expect(hint).toBe(
			"add its path to suites: in forge.yaml (for example `suites: [evals/classify]`, or, when suites is already a block list, add a `- evals/classify` line with the same indentation as the existing entries)",
		);
		expect(hint).not.toContain("under suites:");
		const flowForm = projectFileText("python").replace(
			"suites: []",
			"suites: [evals/classify]",
		);
		expect(parse(flowForm).suites).toEqual(["evals/classify"]);
		// The hint says: same indentation as the existing entries.
		for (const indentation of ["", "  ", "    "]) {
			const blockList = `version: 1\nlanguage: python\nsuites:\n${indentation}- evals/a\n`;
			const withLine = `${blockList}${indentation}- evals/classify\n`;
			expect(parse(withLine).suites).toEqual(["evals/a", "evals/classify"]);
			const project = await readProject(await projectWith(withLine));
			expect(project.suites.map((suite) => suite.entry)).toEqual([
				"evals/a",
				"evals/classify",
			]);
		}
	});
	test("registerSuite keeps init's flow list a flow list, with no blank line", async () => {
		const project = await readProject(
			await projectWith(projectFileText("python")),
		);
		expect(registerSuite(project, join(project.root, "evals", "b"))?.text).toBe(
			projectFileText("python").replace("suites: []", "suites: [evals/b]"),
		);
	});
	test("registerSuite keeps a commented flow list a flow list, comments kept", async () => {
		const project = await readProject(
			await projectWith(
				"# mine\nversion: 1\nlanguage: go\nsuites: [evals/a] # mine\n",
			),
		);
		expect(registerSuite(project, join(project.root, "evals", "b"))?.text).toBe(
			"# mine\nversion: 1\nlanguage: go\nsuites: [evals/a, evals/b] # mine\n",
		);
	});
	test("registerSuite keeps a block list a block list, comments kept", async () => {
		const project = await readProject(
			await projectWith(
				"# mine\nversion: 1\nlanguage: go\nsuites:\n  # the first\n  - evals/a # a\n  - evals/c\n\ndefaults: {}\n",
			),
		);
		expect(registerSuite(project, join(project.root, "evals", "b"))?.text).toBe(
			"# mine\nversion: 1\nlanguage: go\nsuites:\n  # the first\n  - evals/a # a\n  - evals/c\n  - evals/b\n\ndefaults: {}\n",
		);
	});
	test("registerSuite does not register a symlinked suite directory twice", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: go\nsuites:\n  - evals/real\n",
		);
		await mkdir(join(root, "evals", "real"), { recursive: true });
		await symlink(join(root, "evals", "real"), join(root, "evals", "link"));
		const project = await readProject(root);
		expect(registerSuite(project, join(root, "evals", "link"))).toBeNull();
		const other = registerSuite(project, join(root, "evals", "other"));
		expect(other?.entry).toBe("evals/other");
	});
	test.skipIf(!filesystemFoldsCase)(
		"registerSuite does not register evals/suite while evals/Suite, the same directory, is listed (skipped on a case-sensitive filesystem, where they are two directories)",
		async () => {
			const root = await projectWith(
				"version: 1\nlanguage: go\nsuites:\n  - evals/Suite\n",
			);
			await mkdir(join(root, "evals", "Suite"), { recursive: true });
			const project = await readProject(root);
			expect(registerSuite(project, join(root, "evals", "suite"))).toBeNull();
		},
	);
	test("readProject keeps the good suites and reports each bad entry by name, without throwing", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: python\nsuites:\n  - evals/a\n  - evals/a/\n  - ../outside\n  - /abs/path\n  - evals\\win\n  - evals/b\n",
		);
		const project = await readProject(root);
		expect(project.suites.map((suite) => suite.entry)).toEqual([
			"evals/a",
			"evals/b",
		]);
		expect(project.suites[0]?.directory).toBe(join(root, "evals", "a"));
		expect(project.problems).toEqual([
			{ entry: "evals/a/", reason: 'suite "evals/a/" is listed twice' },
			{
				entry: "../outside",
				reason: 'suite "../outside" climbs out of the project',
			},
			{
				entry: "/abs/path",
				reason:
					'suite "/abs/path" is an absolute path; list it relative to forge.yaml',
			},
			{
				entry: "evals\\win",
				reason:
					'suite "evals\\win" uses a backslash; write paths with forward slashes',
			},
		]);
	});
	test("a forge.yaml that does not parse or match the schema throws, naming the file", async () => {
		const root = await projectWith("version: 2\nlanguage: python\n");
		await expect(readProject(root)).rejects.toThrow(join(root, "forge.yaml"));
	});
	test("registerSuite appends one entry with forward slashes and keeps every comment; an entry already there returns null", async () => {
		const text =
			"# the project file\nversion: 1\nlanguage: python # main language\nsuites:\n  - evals/a # first\n";
		const root = await projectWith(text);
		const project = await readProject(root);
		const registered = registerSuite(project, join(root, "evals", "b"));
		expect(registered?.entry).toBe("evals/b");
		expect(registered?.text).toBe(
			"# the project file\nversion: 1\nlanguage: python # main language\nsuites:\n  - evals/a # first\n  - evals/b\n",
		);
		expect(registerSuite(project, join(root, "evals", "a"))).toBeNull();
	});
	test("registerSuite on a file with no suites key, or with suites: [], adds the list", async () => {
		const bare = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		expect(registerSuite(bare, join(bare.root, "x"))?.text).toContain(
			"suites:\n  - x\n",
		);
		const empty = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: []\n"),
		);
		expect(
			parse(registerSuite(empty, join(empty.root, "x"))?.text ?? "").suites,
		).toEqual(["x"]);
	});
	test("registerSuite treats ./evals/a/ and evals/a/ as the already-registered evals/a", async () => {
		for (const written of ["./evals/a/", "evals/a/"]) {
			const project = await readProject(
				await projectWith(
					`version: 1\nlanguage: go\nsuites:\n  - ${written}\n`,
				),
			);
			expect(
				registerSuite(project, join(project.root, "evals", "a")),
			).toBeNull();
		}
	});
	test("registerSuite refuses a directory outside the project, naming forge.yaml", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		const outside = join(project.root, "..", "elsewhere");
		expect(() => registerSuite(project, outside)).toThrow(
			`${outside} is outside the project at ${project.root}; a suite must live inside it`,
		);
		expect(() => registerSuite(project, outside)).toThrow(project.file);
	});
	test("a bare suites: (with or without a comment) reads as an empty list and registerSuite then adds the list", async () => {
		for (const line of ["suites:", "suites: # c"]) {
			const project = await readProject(
				await projectWith(`version: 1\nlanguage: go\n${line}\n`),
			);
			expect(project.suites).toEqual([]);
			const text = registerSuite(project, join(project.root, "x"))?.text ?? "";
			expect(parse(text).suites).toEqual(["x"]);
		}
	});
	test("a bare suites: with a trailing comment keeps the comment on the key's line, above the new item", async () => {
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\nsuites: # none yet\ndefaults: {}\n",
			),
		);
		expect(registerSuite(project, join(project.root, "evals/x"))?.text).toBe(
			"version: 1\nlanguage: go\nsuites: # none yet\n  - evals/x\ndefaults: {}\n",
		);
	});
	test("a comment on the line below a bare suites: stays above the new item", async () => {
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\nsuites:\n  # registered by describe\ndefaults: {}\n",
			),
		);
		const text = registerSuite(project, join(project.root, "evals/x"))?.text;
		expect(parse(text ?? "").suites).toEqual(["evals/x"]);
		expect(text).toContain("# registered by describe");
	});
	test("registerSuite keeps the trailing comment on suites: [] # keep", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: [] # keep\n"),
		);
		const text = registerSuite(project, join(project.root, "x"))?.text ?? "";
		expect(text).toContain("# keep");
		expect(parse(text).suites).toEqual(["x"]);
	});
	test("registeredSuiteNames lists the entries, or says none yet", async () => {
		expect(
			registeredSuiteNames(
				await readProject(await projectWith("version: 1\nlanguage: go\n")),
			),
		).toBe("none yet");
		expect(
			registeredSuiteNames(
				await readProject(
					await projectWith(
						"version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/b\n",
					),
				),
			),
		).toBe("evals/a, evals/b");
	});
	test("projectFileText reads back as the language with no suites and empty defaults", async () => {
		const root = await projectWith(projectFileText("elixir"));
		const project = await readProject(root);
		expect(project.config).toEqual({
			version: 1,
			language: "elixir",
			suites: [],
			defaults: {},
		});
	});
	test("uncommenting any one default in projectFileText, or all of them, still reads", async () => {
		const text = projectFileText("python");
		const expected: Record<string, unknown> = {
			drafter: "google/gemini-3.5-flash",
			target_models: ["anthropic/claude-haiku-4-5"],
			judges: ["google/gemini-3.5-flash"],
		};
		for (const [name, value] of Object.entries(expected)) {
			expect(text).toContain(`\n  # ${name}: `);
			const uncommented = text.replace(`  # ${name}: `, `  ${name}: `);
			const project = await readProject(await projectWith(uncommented));
			expect(project.config.defaults).toEqual({ [name]: value });
		}
		const all = text.replaceAll("  # ", "  ");
		expect((await readProject(await projectWith(all))).config.defaults).toEqual(
			expected,
		);
	});
});

/** The forge.yaml text after registering `<root>/<suite>` in a project whose file is `text`. */
async function registeredText(
	text: string,
	suite = "evals/b",
): Promise<string> {
	const project = await readProject(await projectWith(text));
	const registered = registerSuite(project, join(project.root, suite));
	if (registered === null) throw new Error(`${suite} was already registered`);
	// Whatever registration writes must read back with the entry added.
	expect(parse(registered.text).suites).toEqual([
		...project.config.suites,
		registered.entry,
	]);
	return registered.text;
}

describe("registerSuite changes only the line it adds", () => {
	test("a CRLF block list gets a CRLF line at the last item's indent, and nothing else changes", async () => {
		expect(
			await registeredText(
				"version: 1\r\nlanguage: go\r\nsuites:\r\n    - evals/a # first\r\n    - evals/c\r\n\r\ndefaults: {  }\r\n",
			),
		).toBe(
			"version: 1\r\nlanguage: go\r\nsuites:\r\n    - evals/a # first\r\n    - evals/c\r\n    - evals/b\r\n\r\ndefaults: {  }\r\n",
		);
	});
	test("a block list at column zero, followed by another key", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n- evals/a\ndefaults:\n  judges: [ a ]\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites:\n- evals/a\n- evals/b\ndefaults:\n  judges: [ a ]\n",
		);
	});
	test("a trailing comment on the last item stays on that item", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/c   # the last\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/c   # the last\n  - evals/b\n",
		);
	});
	test("a comment after suites: stays where it was", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: # my suites\n  - evals/a\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: # my suites\n  - evals/a\n  - evals/b\n",
		);
	});
	test("a file with no trailing newline gets the line at the end, still with none", async () => {
		expect(
			await registeredText("version: 1\nlanguage: go\nsuites:\n  - evals/a"),
		).toBe("version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/b");
		expect(
			await registeredText("version: 1\r\nlanguage: go\r\nsuites: [evals/a]"),
		).toBe("version: 1\r\nlanguage: go\r\nsuites: [evals/a, evals/b]");
	});
	test("a one-line flow list gets `, <entry>` after its last item, its own spacing kept", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [ evals/a ,evals/c ]  # mine\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: [ evals/a ,evals/c, evals/b ]  # mine\n",
		);
	});
	test("a one-line flow list with a trailing comma keeps it after the new entry", async () => {
		expect(
			await registeredText("version: 1\nlanguage: go\nsuites: [evals/a,]\n"),
		).toBe("version: 1\nlanguage: go\nsuites: [evals/a, evals/b,]\n");
		expect(
			await registeredText("version: 1\nlanguage: go\nsuites: [evals/a ,]\n"),
		).toBe("version: 1\nlanguage: go\nsuites: [evals/a , evals/b,]\n");
	});
	test("a multi-line flow list gets its own line at the last item's indent", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [\n    evals/a, # first\n    evals/c # last\n]\ndefaults: {}\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: [\n    evals/a, # first\n    evals/c, # last\n    evals/b\n]\ndefaults: {}\n",
		);
		// A comma later on the line, in a comment, is not a trailing comma.
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [\n  evals/c # a, b\n]\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: [\n  evals/c, # a, b\n  evals/b\n]\n",
		);
	});
	test("a multi-line CRLF flow list with a trailing comma keeps the comma style and the comment", async () => {
		expect(
			await registeredText(
				"version: 1\r\nlanguage: go\r\nsuites: [\r\n  evals/a,\r\n  evals/c, # last\r\n]\r\n",
			),
		).toBe(
			"version: 1\r\nlanguage: go\r\nsuites: [\r\n  evals/a,\r\n  evals/c, # last\r\n  evals/b,\r\n]\r\n",
		);
	});
	test("a flow list whose last item shares the line of `]` is extended on that line", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [\n  evals/a, evals/c]\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: [\n  evals/a, evals/c, evals/b]\n",
		);
		expect(
			await registeredText("version: 1\nlanguage: go\nsuites: [evals/a\n  ]\n"),
		).toBe("version: 1\nlanguage: go\nsuites: [evals/a, evals/b\n  ]\n");
	});
	test("an empty flow list gets the entry inside its brackets", async () => {
		expect(
			await registeredText(
				"version: 1\r\nlanguage: go\r\nsuites: []   # none yet\r\ndefaults: { }\r\n",
			),
		).toBe(
			"version: 1\r\nlanguage: go\r\nsuites: [evals/b]   # none yet\r\ndefaults: { }\r\n",
		);
	});
	test("an empty flow list whose `]` has its own line gets the entry on an indented line of its own", async () => {
		expect(
			await registeredText("version: 1\nlanguage: go\nsuites: [ # none\n]\n"),
		).toBe("version: 1\nlanguage: go\nsuites: [ # none\n  evals/b\n]\n");
		expect(
			await registeredText("version: 1\r\nlanguage: go\r\nsuites: [\r\n]\r\n"),
		).toBe("version: 1\r\nlanguage: go\r\nsuites: [\r\n  evals/b\r\n]\r\n");
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [\n  # none\n]\n",
			),
		).toBe("version: 1\nlanguage: go\nsuites: [\n  # none\n  evals/b\n]\n");
		// The first line with content inside the brackets sets the indentation.
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [\n\n    # none\n  ]\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites: [\n\n    # none\n    evals/b\n  ]\n",
		);
		// With nothing inside, the default is the key's indent plus two.
		expect(
			await registeredText("  version: 1\n  language: go\n  suites: [\n  ]\n"),
		).toBe("  version: 1\n  language: go\n  suites: [\n    evals/b\n  ]\n");
	});
	test("an entry YAML would misread is quoted for the list's own style", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [evals/a]\n",
				"evals/b,c",
			),
		).toBe('version: 1\nlanguage: go\nsuites: [evals/a, "evals/b,c"]\n');
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - evals/a\n",
				"evals/b #c",
			),
		).toBe(
			'version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - "evals/b #c"\n',
		);
		// A comma needs quotes only inside a flow list.
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - evals/a\n",
				"evals/b,c",
			),
		).toBe("version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/b,c\n");
	});
	test("a missing suites is added through the document, keeping CRLF", async () => {
		expect(
			await registeredText("# mine\r\nversion: 1\r\nlanguage: go # lang\r\n"),
		).toBe(
			"# mine\r\nversion: 1\r\nlanguage: go # lang\r\nsuites:\r\n  - evals/b\r\n",
		);
		expect(await registeredText("version: 1\nlanguage: go\n")).toBe(
			"version: 1\nlanguage: go\nsuites:\n  - evals/b\n",
		);
		// The printer's own flow padding and line folding would change these.
		const defaults =
			"defaults:\n  judges: [google/gemini-3.5-flash, anthropic/claude-haiku-4-5, openai/gpt-5-mini]\n";
		expect(await registeredText(`version: 1\nlanguage: go\n${defaults}`)).toBe(
			`version: 1\nlanguage: go\n${defaults}suites:\n  - evals/b\n`,
		);
	});
	test("a suites: null is replaced through the document, keeping CRLF and its comment on the key's line", async () => {
		expect(
			await registeredText(
				"version: 1\r\nlanguage: go\r\nsuites: null # none yet\r\ndefaults: {}\r\n",
			),
		).toBe(
			"version: 1\r\nlanguage: go\r\nsuites: # none yet\r\n  - evals/b\r\ndefaults: {}\r\n",
		);
	});
	test("a block scalar as the last item gets the new line after its content, not after the next key", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - >-\n    evals/a\ndefaults: {}\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites:\n  - >-\n    evals/a\n  - evals/b\ndefaults: {}\n",
		);
	});
	test("a splice that would not read back as the old suites plus the new one is refused, naming forge.yaml, and nothing is returned", async () => {
		// `|+` keeps the blank line after its content as part of the value;
		// a line inserted after the content takes that blank line away.
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\nsuites:\n  - |+\n    evals/a\n\ndefaults: {}\n",
			),
		);
		expect(project.config.suites).toEqual(["evals/a\n\n"]);
		const register = () =>
			registerSuite(project, join(project.root, "evals", "b"));
		expect(register).toThrow(
			`registering evals/b would write a forge.yaml that does not read back as the listed suites plus this one, so it was left unchanged; ${registrationHint("evals/b")} (file: ${project.file})`,
		);
	});
	test("checkRegisteredText refuses text with a YAML error or no document, even when what it can read looks right", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		const refusal = `registering evals/b would write a forge.yaml that does not read back as the listed suites plus this one, so it was left unchanged; ${registrationHint("evals/b")} (file: ${project.file})`;
		// A duplicate key is an error, though `suites` itself reads as wanted.
		const duplicated =
			"version: 1\nlanguage: go\nsuites: [evals/b]\nsuites: [evals/b]\n";
		expect(() => checkRegisteredText(project, duplicated, "evals/b")).toThrow(
			refusal,
		);
		expect(() => checkRegisteredText(project, "", "evals/b")).toThrow(refusal);
		expect(() =>
			checkRegisteredText(
				project,
				"version: 1\nlanguage: go\nsuites: [evals/b]\n",
				"evals/b",
			),
		).not.toThrow();
	});
	test("a suites that is a YAML alias is refused, naming forge.yaml, rather than replaced", async () => {
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\ndefaults:\n  judges: &list [evals/a]\nsuites: *list\n",
			),
		);
		const register = () =>
			registerSuite(project, join(project.root, "evals", "b"));
		expect(register).toThrow(
			`suites: is a YAML alias, which registering cannot extend; ${registrationHint("evals/b")} (file: ${project.file})`,
		);
	});
	test("a last item whose value starts on the line after its dash gets the new line at the list's own indentation", async () => {
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - evals/c\n  -\n    evals/a\ndefaults: {}\n",
			),
		).toBe(
			"version: 1\nlanguage: go\nsuites:\n  - evals/c\n  -\n    evals/a\n  - evals/b\ndefaults: {}\n",
		);
	});
	test("a long entry is written on one line, in a block list as in a flow list", async () => {
		const long = `evals/${"a long name ".repeat(9)}z`;
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites:\n  - evals/a\n",
				long,
			),
		).toBe(`version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - ${long}\n`);
		expect(
			await registeredText(
				"version: 1\nlanguage: go\nsuites: [evals/a]\n",
				long,
			),
		).toBe(`version: 1\nlanguage: go\nsuites: [evals/a, ${long}]\n`);
	});
	test("a forge.yaml written as one flow mapping, its list starting a line, is extended inside the brackets", async () => {
		const head = "{version: 1, language: go, suites:\n";
		expect(await registeredText(`${head}[]}\n`)).toBe(`${head}[evals/b]}\n`);
		expect(await registeredText(`${head}[evals/a\n]}\n`)).toBe(
			`${head}[evals/a, evals/b\n]}\n`,
		);
	});
	test("a project whose text no longer lists the suites it was read with is refused, never written with the new entry alone", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: [evals/a]\n"),
		);
		const changed = { ...project, text: "version: 1\nlanguage: go\n" };
		expect(() =>
			registerSuite(changed, join(project.root, "evals", "b")),
		).toThrow(
			`registering evals/b would write a forge.yaml that does not read back as the listed suites plus this one, so it was left unchanged; ${registrationHint("evals/b")} (file: ${project.file})`,
		);
	});
});

describe("which directories are suites of the project", () => {
	test("a Windows path is absolute on every platform: a drive path or a UNC share is refused, since forge.yaml is shared", async () => {
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\nsuites:\n  - C:/evals\n  - //server/share/evals\n  - C:\\evals\n  - evals/a\n",
			),
		);
		expect(project.suites.map((suite) => suite.entry)).toEqual(["evals/a"]);
		expect(project.problems).toEqual([
			{
				entry: "C:/evals",
				reason:
					'suite "C:/evals" is an absolute path; list it relative to forge.yaml',
			},
			{
				entry: "//server/share/evals",
				reason:
					'suite "//server/share/evals" is an absolute path; list it relative to forge.yaml',
			},
			{
				entry: "C:\\evals",
				reason:
					'suite "C:\\evals" uses a backslash; write paths with forward slashes',
			},
		]);
	});
	test("an entry that climbs to the project's parent, however it is spelled, is a problem, not a suite", async () => {
		const project = await readProject(
			await projectWith(
				"version: 1\nlanguage: go\nsuites:\n  - ..\n  - ../\n  - evals/../..\n  - evals/a\n",
			),
		);
		expect(project.suites.map((suite) => suite.entry)).toEqual(["evals/a"]);
		expect(project.problems).toEqual(
			["..", "../", "evals/../.."].map((entry) => ({
				entry,
				reason: `suite "${entry}" climbs out of the project`,
			})),
		);
	});
	test("registerSuite refuses the project's parent itself, as it refuses a sibling", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\n"),
		);
		const parent = join(project.root, "..");
		expect(() => registerSuite(project, parent)).toThrow(
			`${parent} is outside the project at ${project.root}; a suite must live inside it`,
		);
	});
	test("the project root itself registers as the entry `.`", async () => {
		const project = await readProject(
			await projectWith("version: 1\nlanguage: go\nsuites: []\n"),
		);
		expect(registerSuite(project, project.root)).toEqual({
			entry: ".",
			text: "version: 1\nlanguage: go\nsuites: [.]\n",
		});
	});
	test("a symlink to any listed suite is that suite; another existing directory is a new one", async () => {
		const root = await projectWith(
			"version: 1\nlanguage: go\nsuites:\n  - evals/a\n  - evals/b\n",
		);
		for (const name of ["a", "b", "c"])
			await mkdir(join(root, "evals", name), { recursive: true });
		await symlink(join(root, "evals", "b"), join(root, "evals", "link"));
		const project = await readProject(root);
		expect(registerSuite(project, join(root, "evals", "link"))).toBeNull();
		expect(registerSuite(project, join(root, "evals", "c"))?.entry).toBe(
			"evals/c",
		);
	});
});

describe("projectFileText", () => {
	test("the project file init writes, in full", () => {
		expect(projectFileText("go")).toBe(
			[
				"# llm-tests-forge project file. `llm-tests-forge guide` explains every key.",
				"version: 1",
				"language: go",
				"suites: []",
				"defaults:",
				"  # drafter: google/gemini-3.5-flash",
				"  # target_models: [anthropic/claude-haiku-4-5]",
				"  # judges: [google/gemini-3.5-flash]",
				"",
			].join("\n"),
		);
	});
});
