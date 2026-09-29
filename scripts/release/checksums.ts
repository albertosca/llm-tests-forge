import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError, UsageError } from "../../src/core/errors";
import { runMain } from "./entry";
import { CHECKSUMS_FILE_NAME, RELEASE_TARGETS } from "./targets";

async function sha256Of(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

/** Writes `SHA256SUMS` (`sha256sum` format) for every release asset present in `directory`, sorted by name; returns the file's text. */
export async function writeChecksums(directory: string): Promise<string> {
	const present = new Set(await readdir(directory));
	const names = RELEASE_TARGETS.map((target) => target.assetName)
		.filter((assetName) => present.has(assetName))
		.sort();
	if (names.length === 0)
		throw new ForgeError("no release binary to checksum", { file: directory });
	const lines: string[] = [];
	for (const name of names)
		lines.push(`${await sha256Of(join(directory, name))}  ${name}`);
	const text = `${lines.join("\n")}\n`;
	await writeFile(join(directory, CHECKSUMS_FILE_NAME), text);
	return text;
}

/** One line of `SHA256SUMS` whose file is missing or whose bytes no longer hash to the recorded value. */
export interface ChecksumMismatch {
	name: string;
	reason: "missing" | "different";
}

/** Reads `SHA256SUMS` in `directory` and names every file that is missing or differs from its recorded hash. */
export async function verifyChecksums(
	directory: string,
): Promise<ChecksumMismatch[]> {
	const sumsPath = join(directory, CHECKSUMS_FILE_NAME);
	let text: string;
	try {
		text = await readFile(sumsPath, "utf8");
	} catch {
		throw new ForgeError(`${CHECKSUMS_FILE_NAME} cannot be read`, {
			file: sumsPath,
		});
	}
	const mismatches: ChecksumMismatch[] = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const expected = line.slice(0, 64);
		const name = line.slice(66);
		if (
			!/^[0-9a-f]{64}$/.test(expected) ||
			line.slice(64, 66) !== "  " ||
			name === ""
		)
			throw new ForgeError(`malformed line: ${line}`, { file: sumsPath });
		let actual: string;
		try {
			actual = await sha256Of(join(directory, name));
		} catch {
			mismatches.push({ name, reason: "missing" });
			continue;
		}
		if (actual !== expected) mismatches.push({ name, reason: "different" });
	}
	return mismatches;
}

/** `checksums.ts <directory>`: writes `SHA256SUMS`, prints it, returns the exit code. */
export async function runChecksums(
	argumentsList: string[],
	print: (line: string) => void,
): Promise<number> {
	const [directory, ...extra] = argumentsList;
	if (directory === undefined || extra.length > 0)
		throw new UsageError("usage: checksums.ts <directory>");
	print((await writeChecksums(directory)).trimEnd());
	return 0;
}

await runMain(import.meta.main, runChecksums);
