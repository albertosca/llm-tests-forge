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

export async function askExpectedFor(
	c: Case,
	oracle: Oracle,
	io: Io,
): Promise<Expected> {
	switch (oracle) {
		case "label": {
			io.stdout(`expected label for ${c.id}:`);
			return { label: (await io.stdin()).trim() };
		}
		case "fields": {
			io.stdout(`expected fields for ${c.id} as field=value, comma separated:`);
			const fields: Record<string, string> = {};
			for (const pair of (await io.stdin()).split(",")) {
				const [k, ...rest] = pair.split("=");
				if (k?.trim()) fields[k.trim()] = rest.join("=").trim();
			}
			return { fields };
		}
		case "rubric": {
			io.stdout(`rubric sentence for ${c.id}:`);
			return { rubric: (await io.stdin()).trim() };
		}
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
