import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError, type ForgeErrorDetails } from "../core/errors";
import type { Case, Expected, Oracle } from "../core/schemas";
import type { InteractiveReader } from "./interruptible-stdin";

/**
 * A Ctrl+C reached the pass while it was doing something other than
 * asking approve/reject/edit/skip. It is a `ForgeError` so nothing above
 * the review loop mistakes it for a bug, but the loop does not treat it as
 * a bad answer to retry: the person asked to stop, so the item on screen
 * and every later one are skipped and the pass ends (see `runReviewLoop`).
 * The constructors are written out for the coverage reason `UsageError`
 * gives.
 */
export class ReviewInterruptedError extends ForgeError {
	constructor(message: string, details: ForgeErrorDetails = {}) {
		super(message, details);
		this.name = "ReviewInterruptedError";
	}
}

/** `$EDITOR` ended by Ctrl+C rather than closed. */
export class EditorInterruptedError extends ReviewInterruptedError {
	constructor(message: string, details: ForgeErrorDetails = {}) {
		super(message, details);
		this.name = "EditorInterruptedError";
	}
}

/** The input ended (a Ctrl+C) while an expected value was being asked for. */
export class InputEndedError extends ReviewInterruptedError {
	constructor(message: string, details: ForgeErrorDetails = {}) {
		super(message, details);
		this.name = "InputEndedError";
	}
}

/**
 * What a review question reads and prints through. `stdin` is an
 * `InteractiveReader`, not a plain function: only a started interactive
 * pass makes one, so asking a question through a reader nobody armed does
 * not compile (see `src/cli/interruptible-stdin.ts`).
 */
export type Io = {
	stdin: InteractiveReader;
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
		// An exact answer is also a prefix, so the prefix test alone covers it.
		const hit = choices.find(
			(choice) => choice.startsWith(raw) && raw.length > 0,
		);
		if (hit) return hit;
		if (raw === "") {
			if (await confirmedSkip(io)) return choices[choices.length - 1] as string; // empty line = last choice (skip)
			continue;
		}
		io.stdout(`please answer one of: ${choices.join(", ")}`);
	}
}

/**
 * An empty Enter is easy to hit by accident, so it asks before it skips.
 * A second empty answer counts as yes: stdin at EOF (a pipe, `< /dev/null`,
 * a drained test queue) returns the empty string forever, and a question
 * that insisted on y or n would never end there.
 */
async function confirmedSkip(io: Io): Promise<boolean> {
	for (;;) {
		io.stdout("skip this item? [y/n]");
		const raw = (await io.stdin()).trim().toLowerCase();
		if (raw === "" || raw === "y" || raw === "yes") return true;
		if (raw === "n" || raw === "no") return false;
		io.stdout("please answer y or n");
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
		// After a Ctrl+C every read answers "": re-asking printed "try
		// again" three times and failed as if the person had typed nothing.
		if (io.stdin.inputEnded())
			throw new InputEndedError(
				"the input ended while an expected value was asked for",
				{ id: caseEntry.id },
			);
		if (attempt === EXPECTED_ATTEMPTS)
			throw new ForgeError(
				`no usable expected value after ${EXPECTED_ATTEMPTS} attempts: ${problem}`,
				{ id: caseEntry.id },
			);
		io.stdout(`${problem}; try again`);
	}
}

/**
 * What `openInEditor` needs of the editor it starts; `Bun.spawn`'s result is
 * one. Named so a test can stand in for the process: the real one reports a
 * Ctrl+C as exit code 130 and as `signalCode` both, so only a stand-in can
 * show that either alone is enough.
 */
export type EditorProcess = {
	exited: Promise<number>;
	signalCode: string | null;
};

export type SpawnEditor = (
	command: string[],
	options: { stdio: ["inherit", "inherit", "inherit"] },
) => EditorProcess;

export async function openInEditor(
	yamlText: string,
	environment: Record<string, string | undefined> = process.env,
	spawn: SpawnEditor = Bun.spawn,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-edit-"));
	const path = join(directory, "item.yaml");
	await writeFile(path, yamlText, "utf8");
	const editor = environment.EDITOR ?? "vi";
	const editorProcess = spawn([editor, path], {
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
