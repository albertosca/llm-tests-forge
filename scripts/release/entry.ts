import { ForgeError, UsageError } from "../../src/core/errors";

/** Runs a release script's action and turns a `ForgeError` into its message and an exit code: 2 for a bad command line, 1 for a failure. */
export async function runScript(
	action: () => Promise<number>,
	printError: (line: string) => void = console.error,
): Promise<number> {
	try {
		return await action();
	} catch (error) {
		if (!(error instanceof ForgeError)) throw error;
		printError(`error: ${error.message}`);
		return error instanceof UsageError ? 2 : 1;
	}
}

/**
 * The one line every script ends with: when the file is the program being
 * run (`isMain`), runs `run` on the command line and exits with its code.
 * Kept here, with `exit` injectable, so a script's own last line is a plain
 * call that a test executes on import.
 */
export async function runMain(
	isMain: boolean,
	run: (
		argumentsList: string[],
		print: (line: string) => void,
	) => Promise<number>,
	argumentsList: string[] = Bun.argv.slice(2),
	print: (line: string) => void = console.log,
	exit: (code: number) => void = process.exit,
): Promise<void> {
	if (!isMain) return;
	exit(await runScript(() => run(argumentsList, print)));
}
