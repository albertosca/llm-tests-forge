import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runChecksums,
	verifyChecksums,
	writeChecksums,
} from "../../scripts/release/checksums";
import { ForgeError, UsageError } from "../../src/core/errors";

async function directoryWith(files: Record<string, string>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "forge-checksums-"));
	for (const [name, content] of Object.entries(files))
		await writeFile(join(directory, name), content);
	return directory;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

describe("checksums", () => {
	test("SHA256SUMS lists every asset present in sha256sum format, sorted by name, and nothing else", async () => {
		const directory = await directoryWith({
			"llm-tests-forge-linux-x64": "linux",
			"llm-tests-forge-linux-arm64": "arm",
			"notes.txt": "not an asset",
		});
		const text = await writeChecksums(directory);
		// Target order is linux-x64 then linux-arm64; sorted order is the reverse.
		const expected = `${sha256("arm")}  llm-tests-forge-linux-arm64\n${sha256("linux")}  llm-tests-forge-linux-x64\n`;
		expect(text).toBe(expected);
		expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toBe(
			expected,
		);
	});

	test("a directory with no release binary is refused, naming it", async () => {
		const directory = await directoryWith({ "notes.txt": "x" });
		await expect(writeChecksums(directory)).rejects.toThrow(
			`no release binary to checksum (file: ${directory})`,
		);
	});

	test("a written SHA256SUMS verifies with no mismatch, even after being rewritten", async () => {
		const directory = await directoryWith({
			"llm-tests-forge-linux-x64": "linux",
			"llm-tests-forge-windows-x64.exe": "windows",
		});
		await writeChecksums(directory);
		await writeChecksums(directory);
		expect(await verifyChecksums(directory)).toEqual([]);
	});

	test("one corrupted byte is named, and the untouched file is not", async () => {
		const directory = await directoryWith({
			"llm-tests-forge-linux-x64": "linux",
			"llm-tests-forge-linux-arm64": "arm",
		});
		await writeChecksums(directory);
		await writeFile(join(directory, "llm-tests-forge-linux-x64"), "linuX");
		expect(await verifyChecksums(directory)).toEqual([
			{ name: "llm-tests-forge-linux-x64", reason: "different" },
		]);
	});

	test("a recorded file that has gone missing is named as missing", async () => {
		const directory = await directoryWith({ "llm-tests-forge-linux-x64": "a" });
		await writeChecksums(directory);
		await rm(join(directory, "llm-tests-forge-linux-x64"));
		expect(await verifyChecksums(directory)).toEqual([
			{ name: "llm-tests-forge-linux-x64", reason: "missing" },
		]);
	});

	test("an asset present in the directory but absent from SHA256SUMS is named as unlisted; a non-asset file is not", async () => {
		const directory = await directoryWith({
			"llm-tests-forge-linux-x64": "a",
			"notes.txt": "x",
		});
		await writeChecksums(directory);
		await writeFile(join(directory, "llm-tests-forge-linux-arm64"), "b");
		expect(await verifyChecksums(directory)).toEqual([
			{ name: "llm-tests-forge-linux-arm64", reason: "unlisted" },
		]);
	});

	test("a directory without SHA256SUMS is refused, naming the file", async () => {
		const directory = await directoryWith({});
		await expect(verifyChecksums(directory)).rejects.toThrow(
			`SHA256SUMS cannot be read (file: ${join(directory, "SHA256SUMS")})`,
		);
	});

	test("a malformed line is refused, naming the file and the line", async () => {
		for (const line of [
			"not-a-hash  llm-tests-forge-linux-x64",
			`${sha256("a")} llm-tests-forge-linux-x64`,
			`${sha256("a")}  `,
			`${sha256("a")}  ../llm-tests-forge-linux-x64`,
			`${sha256("a")}  sub/llm-tests-forge-linux-x64`,
			`${sha256("a")}  sub\\llm-tests-forge-linux-x64`,
			`${sha256("a")}  ..`,
			`${sha256("a")}  .`,
		]) {
			const directory = await directoryWith({ SHA256SUMS: `${line}\n` });
			await expect(verifyChecksums(directory)).rejects.toThrow(
				`malformed line: ${line} (file: ${join(directory, "SHA256SUMS")})`,
			);
		}
	});

	test("blank lines in SHA256SUMS are ignored", async () => {
		const directory = await directoryWith({
			"llm-tests-forge-linux-x64": "a",
			SHA256SUMS: `\n${sha256("a")}  llm-tests-forge-linux-x64\n\n`,
		});
		expect(await verifyChecksums(directory)).toEqual([]);
	});

	test("the command writes the file, prints it, and exits 0", async () => {
		const directory = await directoryWith({ "llm-tests-forge-linux-x64": "a" });
		const printed: string[] = [];
		expect(await runChecksums([directory], (line) => printed.push(line))).toBe(
			0,
		);
		expect(printed).toEqual([`${sha256("a")}  llm-tests-forge-linux-x64`]);
	});

	test("the command wants exactly one directory", async () => {
		for (const argumentsList of [[], ["a", "b"]])
			await expect(runChecksums(argumentsList, () => {})).rejects.toThrow(
				UsageError,
			);
		await expect(runChecksums([], () => {})).rejects.toBeInstanceOf(ForgeError);
	});
});
