import { describe, expect, test } from "bun:test";
import { askChoice, askExpectedFor, openInEditor } from "../../src/cli/prompts";
import { ForgeError } from "../../src/core/errors";
import type { Case } from "../../src/core/schemas";

const CHOICES = ["approve", "reject", "edit", "skip"];

function scriptedIo(lines: string[]) {
	const queue = [...lines];
	const out: string[] = [];
	return {
		io: {
			stdin: async () => queue.shift() ?? "",
			stdout: (l: string) => out.push(l),
		},
		out,
	};
}

const aCase: Case = {
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
		expect(out.filter((l) => l.startsWith("q [")).length).toBe(2);
		expect(
			out.some((l) => l === `please answer one of: ${CHOICES.join(", ")}`),
		).toBe(true);
	});
});

/** Accepts anything: for the tests that are not about the oracle rule. */
const anything = () => null;

describe("askExpectedFor", () => {
	test("label oracle asks for and trims a label", async () => {
		const { io, out } = scriptedIo(["  rejection  "]);
		const result = await askExpectedFor(aCase, "label", io, anything);
		expect(result).toEqual({ label: "rejection" });
		expect(out).toEqual([`expected label for ${aCase.id}:`]);
	});

	test("fields oracle parses comma-separated field=value pairs, keeping '=' inside a value", async () => {
		const { io, out } = scriptedIo(["type=rejection, note=a=b, =dropped"]);
		const result = await askExpectedFor(aCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection", note: "a=b" } });
		expect(out).toEqual([
			`expected fields for ${aCase.id} as field=value, comma separated:`,
		]);
	});

	test("rubric oracle asks for and trims a sentence", async () => {
		const { io, out } = scriptedIo(["  Output mentions the deadline.  "]);
		const result = await askExpectedFor(aCase, "rubric", io, anything);
		expect(result).toEqual({ rubric: "Output mentions the deadline." });
		expect(out).toEqual([`rubric sentence for ${aCase.id}:`]);
	});
});

describe("askExpectedFor: an empty or unusable answer is not an expected value (whole-branch Finding 6)", () => {
	test("an empty label is re-asked, not written as {label: ''}", async () => {
		const { io, out } = scriptedIo(["", "rejection"]);
		const result = await askExpectedFor(aCase, "label", io, anything);
		expect(result).toEqual({ label: "rejection" });
		expect(out).toEqual([
			`expected label for ${aCase.id}:`,
			"an expected label is required; try again",
			`expected label for ${aCase.id}:`,
		]);
	});

	test("an empty fields line is re-asked, not written as {fields: {}} — which any output satisfies", async () => {
		const { io, out } = scriptedIo(["", "type=rejection"]);
		const result = await askExpectedFor(aCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection" } });
		expect(out).toContain("an expected fields is required; try again");
	});

	test("a line of only separators counts as empty for the fields oracle", async () => {
		const { io, out } = scriptedIo([" , , ", "type=rejection"]);
		const result = await askExpectedFor(aCase, "fields", io, anything);
		expect(result).toEqual({ fields: { type: "rejection" } });
		expect(out).toContain("an expected fields is required; try again");
	});

	test("an empty rubric is re-asked, not written as {rubric: ''}", async () => {
		const { io, out } = scriptedIo(["   ", "Mentions the deadline."]);
		const result = await askExpectedFor(aCase, "rubric", io, anything);
		expect(result).toEqual({ rubric: "Mentions the deadline." });
		expect(out).toContain("an expected rubric is required; try again");
	});

	test("an answer the oracle rejects is reported by name and re-asked", async () => {
		const { io, out } = scriptedIo(["maybe", "rejection"]);
		const result = await askExpectedFor(aCase, "label", io, (e) =>
			e.label === "rejection"
				? null
				: `label "${e.label}" is not one of the feature's labels`,
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
		let err: unknown;
		try {
			await askExpectedFor(aCase, "label", io, anything);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toBe(
			`no usable expected value after 3 attempts: an expected label is required (id: ${aCase.id})`,
		);
		expect(
			out.filter((l) => l === `expected label for ${aCase.id}:`).length,
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
		let err: unknown;
		try {
			await openInEditor("id: s-01\n", { EDITOR: "false" });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			'editor "false" exited with 1',
		);
		expect((err as ForgeError).details.file).toMatch(/item\.yaml$/);
	});
});
