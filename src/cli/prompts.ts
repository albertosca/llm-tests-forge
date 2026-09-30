import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError, type ForgeErrorDetails } from "../core/errors";
import type { Case, Expected, Oracle } from "../core/schemas";

/**
 * `$EDITOR` ended by Ctrl+C rather than closed. It is a `ForgeError` so
 * nothing above the review loop mistakes it for a bug, but the loop does
 * not treat it as a bad edit to retry: the person asked to stop, so the
 * item is skipped and the pass ends (see `runReviewLoop`). The constructor
 * is written out for the coverage reason `UsageError` gives.
 */
export class EditorInterruptedError extends ForgeError {
	constructor(message: string, details: ForgeErrorDetails = {}) {
		super(message, details);
		this.name = "EditorInterruptedError";
	}
}

export type Io = {
	stdin: () => Promise<string>;
	stdout: (line: string) => void;
};

export async function askChoice(
	question: string,
	choices: string[],
	io: Io,
): Promise<string> {
	for (;;) {
		io.stdout(`${question} [${choices.join("/")}]`);
		const raw = (await io.stdin()).trim().toLowerCase();
		const hit = choices.find(
			(choice) => choice === raw || (choice.startsWith(raw) && raw.length > 0),
		);
		if (hit) return hit;
		if (raw === "") return choices[choices.length - 1] as string; // empty line = last choice (skip)
		io.stdout(`please answer one of: ${choices.join(", ")}`);
	}
}

/**
 * How many times an unusable answer is re-asked before giving up. An empty
 * answer is re-asked rather than accepted, and stdin can be at EOF — a pipe,
 * `< /dev/null`, a drained test queue — where every further read returns the
 * empty string forever. Re-asking without a bound would hang there instead
 * of failing. The ForgeError raised on exhaustion is caught by the review
 * loop, which re-asks the item itself and then takes the same EOF as "skip".
 */
const EXPECTED_ATTEMPTS = 3;

/** One round of asking, or `null` when the answer was empty. */
async function askExpectedOnce(
	caseEntry: Case,
	oracle: Oracle,
	io: Io,
): Promise<Expected | null> {
	switch (oracle) {
		case "label": {
			io.stdout(`expected label for ${caseEntry.id}:`);
			const label = (await io.stdin()).trim();
			return label === "" ? null : { label };
		}
		case "fields": {
			io.stdout(
				`expected fields for ${caseEntry.id} as field=value, comma separated:`,
			);
			const fields: Record<string, string> = {};
			for (const pair of (await io.stdin()).split(",")) {
				const [key, ...rest] = pair.split("=");
				if (key?.trim()) fields[key.trim()] = rest.join("=").trim();
			}
			return Object.keys(fields).length === 0 ? null : { fields };
		}
		case "rubric": {
			io.stdout(`rubric sentence for ${caseEntry.id}:`);
			const rubric = (await io.stdin()).trim();
			return rubric === "" ? null : { rubric };
		}
	}
}

/**
 * Asks the person for a case's expected output and does not take an
 * unusable answer for it. Pressing Enter used to write `expected: {label:
 * ""}` (or `{fields: {}}`, which any output at all satisfies) and mark the
 * case approved — the competitors' inputs-only suite wearing a field name.
 * `check` is the same rule the model's generated cases are held to, passed
 * in by the caller so this module stays free of the feature and the
 * scenario.
 */
export async function askExpectedFor(
	caseEntry: Case,
	oracle: Oracle,
	io: Io,
	check: (expected: Expected) => string | null,
): Promise<Expected> {
	for (let attempt = 1; ; attempt += 1) {
		const candidate = await askExpectedOnce(caseEntry, oracle, io);
		const problem =
			candidate === null
				? `an expected ${oracle} is required`
				: check(candidate);
		if (candidate !== null && problem === null) return candidate;
		if (attempt === EXPECTED_ATTEMPTS)
			throw new ForgeError(
				`no usable expected value after ${EXPECTED_ATTEMPTS} attempts: ${problem}`,
				{ id: caseEntry.id },
			);
		io.stdout(`${problem}; try again`);
	}
}

export async function openInEditor(
	yamlText: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-edit-"));
	const path = join(directory, "item.yaml");
	await writeFile(path, yamlText, "utf8");
	const editor = environment.EDITOR ?? "vi";
	const editorProcess = Bun.spawn([editor, path], {
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await editorProcess.exited;
	// Ctrl+C reaches the editor too (it shares the terminal's process
	// group). An editor that dies of it exits by the signal, which Bun
	// reports as 130; one that catches it and exits 130 itself is the same
	// request to stop.
	if (code === 130 || editorProcess.signalCode === "SIGINT")
		throw new EditorInterruptedError(`editor "${editor}" was interrupted`, {
			file: path,
		});
	if (code !== 0)
		throw new ForgeError(`editor "${editor}" exited with ${code}`, {
			file: path,
		});
	return readFile(path, "utf8");
}
