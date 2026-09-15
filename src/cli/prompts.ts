import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../core/errors";
import type { Case, Expected, Oracle } from "../core/schemas";

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
			(c) => c === raw || (c.startsWith(raw) && raw.length > 0),
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
	c: Case,
	oracle: Oracle,
	io: Io,
): Promise<Expected | null> {
	switch (oracle) {
		case "label": {
			io.stdout(`expected label for ${c.id}:`);
			const label = (await io.stdin()).trim();
			return label === "" ? null : { label };
		}
		case "fields": {
			io.stdout(`expected fields for ${c.id} as field=value, comma separated:`);
			const fields: Record<string, string> = {};
			for (const pair of (await io.stdin()).split(",")) {
				const [k, ...rest] = pair.split("=");
				if (k?.trim()) fields[k.trim()] = rest.join("=").trim();
			}
			return Object.keys(fields).length === 0 ? null : { fields };
		}
		case "rubric": {
			io.stdout(`rubric sentence for ${c.id}:`);
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
	c: Case,
	oracle: Oracle,
	io: Io,
	check: (expected: Expected) => string | null,
): Promise<Expected> {
	for (let attempt = 1; ; attempt += 1) {
		const candidate = await askExpectedOnce(c, oracle, io);
		const problem =
			candidate === null
				? `an expected ${oracle} is required`
				: check(candidate);
		if (candidate !== null && problem === null) return candidate;
		if (attempt === EXPECTED_ATTEMPTS)
			throw new ForgeError(
				`no usable expected value after ${EXPECTED_ATTEMPTS} attempts: ${problem}`,
				{ id: c.id },
			);
		io.stdout(`${problem}; try again`);
	}
}

export async function openInEditor(
	yamlText: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "forge-edit-"));
	const path = join(dir, "item.yaml");
	await writeFile(path, yamlText, "utf8");
	const editor = env.EDITOR ?? "vi";
	const proc = Bun.spawn([editor, path], {
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await proc.exited;
	if (code !== 0)
		throw new ForgeError(`editor "${editor}" exited with ${code}`, {
			file: path,
		});
	return readFile(path, "utf8");
}
