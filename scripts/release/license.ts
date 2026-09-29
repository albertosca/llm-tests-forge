import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "../../src/core/errors";

/** The file at the repository root that every package ships a copy of. */
export const LICENSE_FILE_NAME = "LICENSE";

/** The path of the repository's LICENSE; refused naming that path when it is missing, so no package is rendered without it. */
export async function licensePath(root: string): Promise<string> {
	const path = join(root, LICENSE_FILE_NAME);
	if (!(await Bun.file(path).exists()))
		throw new ForgeError("the LICENSE every package ships is missing", {
			file: path,
		});
	return path;
}

/** Copies the repository's LICENSE into `directory` under its own name. */
export async function copyLicense(
	root: string,
	directory: string,
): Promise<void> {
	await copyFile(await licensePath(root), join(directory, LICENSE_FILE_NAME));
}
