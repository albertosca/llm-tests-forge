import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Writes `text` as forge.yaml into a fresh temporary directory and returns that directory. */
export async function projectWith(text: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-project-"));
	await writeFile(join(root, "forge.yaml"), text);
	return root;
}
