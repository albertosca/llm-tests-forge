#!/usr/bin/env bun
import { createInterruptibleReader } from "./interruptible-stdin";
import { main } from "./main";

/**
 * The real stdin reader: reads exactly one line from the process's actual
 * standard input. This only makes sense when `llm-tests-forge` is genuinely running
 * as a CLI attached to a terminal or a pipe — it is deliberately kept out
 * of `context.ts` and `main.ts` so those files hold only code a test can
 * assert something about. Nothing here is meant to be unit tested; it is
 * exercised by hand and by the fact that the CLI works at all.
 */
async function readStdinLine(): Promise<string> {
	for await (const line of console) return line;
	return "";
}

// A Ctrl+C exits 130, as it always did, unless `reviewCommand` has armed
// end-of-input mode for its interactive pass (via `startInteractivePass`
// below): then the first interrupt ends the input instead of killing the
// process, so the pass finishes normally and writes what was already
// decided. See interruptible-stdin.ts.
const reader = createInterruptibleReader({
	readLine: readStdinLine,
	stdout: (line) => console.log(line),
	exit: (code) => process.exit(code),
});
process.on("SIGINT", reader.interrupt);

// Provider keys are loaded by `main()` into `env`, after it has answered
// `--help`; see main.ts.
process.exit(
	await main(process.argv.slice(2), {
		cwd: process.cwd(),
		env: process.env,
		stdin: reader.read,
		startInteractivePass: reader.startInteractivePass,
	}),
);
