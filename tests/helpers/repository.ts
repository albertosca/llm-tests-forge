import { join, resolve } from "node:path";

/**
 * The repository root, found from this file and never from the working
 * directory, so a test passes wherever `bun test` is started.
 */
export const REPOSITORY = resolve(import.meta.dir, "../..");

/** Absolute path of a file or directory under `tests/fixtures/`. */
export function fixturePath(...segments: string[]): string {
	return join(REPOSITORY, "tests/fixtures", ...segments);
}
