import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stand-in for the claude executable: records its arguments and stdin, prints a canned reply or fails. */
export async function stubClaude(reply: string, exitCode = 0) {
	const directory = await mkdtemp(join(tmpdir(), "forge-claude-stub-"));
	const command = join(directory, "claude");
	await writeFile(
		command,
		`#!/bin/sh\nprintf '%s\\n' "$@" > "${directory}/arguments"\nenv > "${directory}/environment"\ncat > "${directory}/stdin"\ncat "${directory}/reply" 2>/dev/null\n${exitCode === 0 ? "" : `echo "stub failure" >&2\nexit ${exitCode}\n`}`,
	);
	await chmod(command, 0o755);
	await writeFile(join(directory, "reply"), reply);
	return { command, directory };
}
