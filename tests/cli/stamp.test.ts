import { describe, expect, test } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../src/cli/context";
import { run } from "../../src/cli/main";
import {
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
} from "../../src/core/files";
import { FORGE_VERSION } from "../../src/core/version";

/** Far enough in the past that any real write is distinguishable from it. */
const LONG_AGO = new Date("2000-01-01T00:00:00Z");

/** A `.forge` under `cwd` with an approved feature, one approved case and a python target. */
async function approvedSuite(cwd: string): Promise<string> {
	const forgeDirectory = join(cwd, ".forge");
	await writeFeature(forgeDirectory, {
		id: "classify-email",
		purpose: "Classify a hiring email",
		inputs: [{ name: "email", kind: "text" }],
		output: { kind: "label", labels: ["rejection", "acknowledgement"] },
		invariants: [],
		status: "approved",
	});
	await writeScenarios(forgeDirectory, [
		{
			id: "polite-rejection",
			kind: "happy",
			oracle: "label",
			description: "d",
			status: "approved",
		},
	]);
	await writeCases(forgeDirectory, "polite-rejection", [
		{
			id: "polite-rejection-01",
			scenario: "polite-rejection",
			input: { email: "We will not proceed." },
			expected: { label: "rejection" },
			status: "approved",
			generated_by: "t",
		},
	]);
	await writeSuite(forgeDirectory, {
		target: {
			kind: "python",
			entry: "forge_target.py",
			models: ["anthropic/claude-haiku-4-5"],
		},
		judges: ["google/gemini-3.5-flash"],
		repeat: 1,
		include: [],
	});
	return forgeDirectory;
}

function contextIn(cwd: string) {
	const out: string[] = [];
	const context = createContext({ cwd, stdin: async () => "" });
	context.stdout = (line) => out.push(line);
	return { context, out };
}

/** Every file under `directory`, recursively, as paths relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { recursive: true });
	const files: string[] = [];
	for (const entry of entries)
		if ((await stat(join(directory, entry))).isFile()) files.push(entry);
	return files.sort();
}

describe("the stamp after a writing verb", () => {
	test("emit whose shim write fails after promptfooconfig.yaml was written exits 1 and leaves suite.yaml unstamped", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-stamp-"));
		const forgeDirectory = await approvedSuite(cwd);
		const suitePath = join(forgeDirectory, "suite.yaml");
		const before = await readFile(suitePath, "utf8");
		// The shim's path is a link into a regular file: `exists` says no, and
		// the write that follows it fails with ENOTDIR.
		const blocker = join(cwd, "blocker");
		await writeFile(blocker, "a file, not a directory\n");
		await symlink(
			join(blocker, "forge_target.py"),
			join(forgeDirectory, "forge_target.py"),
		);
		const { context, out } = contextIn(cwd);
		expect(await run(["emit"], context)).toBe(1);
		expect(out[0]).toStartWith(
			`emit: wrote ${join(forgeDirectory, "promptfooconfig.yaml")}`,
		);
		expect(out.at(-1)).toStartWith("error: ");
		expect(out.at(-1)).toContain("forge_target.py");
		expect(
			await readFile(join(forgeDirectory, "promptfooconfig.yaml"), "utf8"),
		).not.toBe("");
		expect(await readFile(suitePath, "utf8")).toBe(before);
		expect(before).not.toContain("forge_version");
	});

	// Accepted by the owner (2026-09-29): a writing verb that succeeds stamps
	// even when it wrote nothing. `review` with nothing pending is one.
	test("a writing verb that exits 0 having written nothing still stamps suite.yaml, and only suite.yaml changes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "forge-stamp-"));
		const forgeDirectory = await approvedSuite(cwd);
		const files = await filesUnder(forgeDirectory);
		for (const file of files)
			await utimes(join(forgeDirectory, file), LONG_AGO, LONG_AGO);
		const { context, out } = contextIn(cwd);
		expect(await run(["review"], context)).toBe(0);
		expect(out.at(-1)).toBe("review: nothing pending");
		expect(await filesUnder(forgeDirectory)).toEqual(files);
		const changed: string[] = [];
		for (const file of files)
			if (
				(await stat(join(forgeDirectory, file))).mtime.getTime() !==
				LONG_AGO.getTime()
			)
				changed.push(file);
		expect(changed).toEqual(["suite.yaml"]);
		expect(
			await readFile(join(forgeDirectory, "suite.yaml"), "utf8"),
		).toStartWith(`forge_version: ${FORGE_VERSION}\n`);
	});
});
