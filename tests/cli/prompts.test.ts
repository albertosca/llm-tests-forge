import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	askChoice,
	askExpectedFor,
	EditorInterruptedError,
	openInEditor,
} from "../../src/cli/prompts";
import { ForgeError } from "../../src/core/errors";
import type { Case } from "../../src/core/schemas";

const CHOICES = ["approve", "reject", "edit", "skip"];

function scriptedIo(lines: string[]) {
	const queue = [...lines];
	const out: string[] = [];
	return {
		io: {
			stdin: async () => queue.shift() ?? "",
			stdout: (line: string) => out.push(line),
		},
		out,
	};
}

const pendingCase: Case = {
	id: "s-01",
	scenario: "s",
	input: { email: "a" },
	status: "pending",
	generated_by: "t",
};

describe("askChoice", () => {
	test("accepts the full word", async () => {
		const { io } = scriptedIo(["approve"]);
		expect(await askChoice("q", CHOICES, io)).toBe("approve");
	});

	test("accepts the first letter", async () => {
		const { io } = scriptedIo(["r"]);
		expect(await askChoice("q", CHOICES, io)).toBe("reject");
	});

	test("an empty line maps to the last choice (skip)", async () => {
		const { io } = scriptedIo([""]);
		expect(await askChoice("q", CHOICES, io)).toBe("skip");
	});

	test("an invalid answer re-asks the same question instead of accepting it", async () => {
		const { io, out } = scriptedIo(["nonsense", "edit"]);
		expect(await askChoice("q", CHOICES, io)).toBe("edit");
		// Re-asked means the question line was printed twice, not once.
		expect(out.filter((line) => line.startsWith("q [")).length).toBe(2);
		expect(
			out.some(
				(line) => line === `please answer one of: ${CHOICES.join(", ")}`,
			),
		).toBe(true);
	});
});

/** Accepts anything: for the tests that are not about the oracle rule. */
const anything = () => null;

describe("askExpectedFor", () => {
	test("label oracle asks for and trims a label", async () => {
		const { io, out } = scriptedIo(["  rejection  "]);
		const result = await askExpectedFor(pendingCase, "label", io, anything);
		expect(result).toEqual({ label: "rejection" });
		expect(out).toEqual([`expected label for ${pendingCase.id}:`]);
	});

	test("fields oracle parses comma-separated field=value pairs, keeping '=' inside a value", async () => {
		const { io, out } = scriptedIo(["type=rejection, note=a=b, =dropped"]);
		const result = await askExpectedFor(pendingCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection", note: "a=b" } });
		expect(out).toEqual([
			`expected fields for ${pendingCase.id} as field=value, comma separated:`,
		]);
	});

	test("rubric oracle asks for and trims a sentence", async () => {
		const { io, out } = scriptedIo(["  Output mentions the deadline.  "]);
		const result = await askExpectedFor(pendingCase, "rubric", io, anything);
		expect(result).toEqual({ rubric: "Output mentions the deadline." });
		expect(out).toEqual([`rubric sentence for ${pendingCase.id}:`]);
	});
});

describe("askExpectedFor: an empty or unusable answer is not an expected value (whole-branch Finding 6)", () => {
	test("an empty label is re-asked, not written as {label: ''}", async () => {
		const { io, out } = scriptedIo(["", "rejection"]);
		const result = await askExpectedFor(pendingCase, "label", io, anything);
		expect(result).toEqual({ label: "rejection" });
		expect(out).toEqual([
			`expected label for ${pendingCase.id}:`,
			"an expected label is required; try again",
			`expected label for ${pendingCase.id}:`,
		]);
	});

	test("an empty fields line is re-asked, not written as {fields: {}} — which any output satisfies", async () => {
		const { io, out } = scriptedIo(["", "type=rejection"]);
		const result = await askExpectedFor(pendingCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection" } });
		expect(out).toContain("an expected fields is required; try again");
	});

	test("a line of only separators counts as empty for the fields oracle", async () => {
		const { io, out } = scriptedIo([" , , ", "type=rejection"]);
		const result = await askExpectedFor(pendingCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection" } });
		expect(out).toContain("an expected fields is required; try again");
	});

	test("an empty rubric is re-asked, not written as {rubric: ''}", async () => {
		const { io, out } = scriptedIo(["   ", "Mentions the deadline."]);
		const result = await askExpectedFor(pendingCase, "rubric", io, anything);
		expect(result).toEqual({ rubric: "Mentions the deadline." });
		expect(out).toContain("an expected rubric is required; try again");
	});

	test("an answer the oracle rejects is reported by name and re-asked", async () => {
		const { io, out } = scriptedIo(["maybe", "rejection"]);
		const result = await askExpectedFor(pendingCase, "label", io, (expected) =>
			expected.label === "rejection"
				? null
				: `label "${expected.label}" is not one of the feature's labels`,
		);
		expect(result).toEqual({ label: "rejection" });
		expect(out).toContain(
			`label "maybe" is not one of the feature's labels; try again`,
		);
	});

	test("three unusable answers in a row raise a ForgeError naming the case, instead of looping forever at EOF", async () => {
		// An exhausted queue reads as "" forever, which is exactly what a
		// piped or redirected stdin does after EOF.
		const { io, out } = scriptedIo([]);
		let caught: unknown;
		try {
			await askExpectedFor(pendingCase, "label", io, anything);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toBe(
			`no usable expected value after 3 attempts: an expected label is required (id: ${pendingCase.id})`,
		);
		expect(
			out.filter((line) => line === `expected label for ${pendingCase.id}:`)
				.length,
		).toBe(3);
	});
});

describe("openInEditor", () => {
	test("round-trips text through a real $EDITOR process (the `true` binary exits 0, leaving the file untouched)", async () => {
		const text = "id: s-01\nstatus: pending\n";
		const result = await openInEditor(text, { EDITOR: "true" });
		expect(result).toBe(text);
	});

	test("a non-zero $EDITOR exit raises a ForgeError naming the editor and the temp file (the `false` binary always exits 1)", async () => {
		let caught: unknown;
		try {
			await openInEditor("id: s-01\n", { EDITOR: "false" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ForgeError);
		expect((caught as ForgeError).message).toContain(
			'editor "false" exited with 1',
		);
		expect((caught as ForgeError).details.file).toMatch(/item\.yaml$/);
		expect(caught).not.toBeInstanceOf(EditorInterruptedError);
	});

	/** An `$EDITOR` stand-in: a shell script, never a real editor. */
	async function editorScript(body: string): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "forge-editor-"));
		const path = join(directory, "editor.sh");
		await writeFile(path, `#!/bin/sh\n${body}\n`);
		await chmod(path, 0o755);
		return path;
	}

	test.each([
		["exits 130", "exit 130"],
		["is killed by SIGINT", "kill -INT $$"],
	])(
		"an $EDITOR that %s raises EditorInterruptedError naming the editor and the temp file",
		async (_label, body) => {
			const editor = await editorScript(body);
			let caught: unknown;
			try {
				await openInEditor("id: s-01\n", { EDITOR: editor });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(EditorInterruptedError);
			expect((caught as EditorInterruptedError).message).toContain(
				`editor "${editor}" was interrupted`,
			);
			expect((caught as EditorInterruptedError).details.file).toMatch(
				/item\.yaml$/,
			);
		},
	);
});
