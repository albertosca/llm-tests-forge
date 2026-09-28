#!/usr/bin/env bun
import { defaultConfigDirectory, loadProviderKeys } from "../llm/credentials";
import { createContext } from "./context";
import { createInterruptibleReader } from "./interruptible-stdin";
import { modelFlag, run } from "./main";

/**
 * The real stdin reader: reads exactly one line from the process's actual
 * standard input. This only makes sense when `forge` is genuinely running
 * as a CLI attached to a terminal or a pipe — it is deliberately kept out
 * of `context.ts` and `main.ts` so those files hold only code a test can
 * assert something about. Nothing here is meant to be unit tested; it is
 * exercised by hand and by the fact that the CLI works at all.
 */
async function readStdinLine(): Promise<string> {
	for await (const line of console) return line;
	return "";
}

// Keys the shell does not export are read from ~/.config/<provider>/api.env;
// a key already in the environment wins.
await loadProviderKeys({
	environment: process.env,
	configDirectory: defaultConfigDirectory(),
});

// A Ctrl+C while `forge review` is waiting on the person ends the input
// instead of killing the process: the pass finishes normally and writes
// what was already decided. Anywhere else — a model call, a write — it
// exits 130 as Ctrl+C always did. See interruptible-stdin.ts.
const reader = createInterruptibleReader({
	readLine: readStdinLine,
	stdout: (line) => console.log(line),
	exit: (code) => process.exit(code),
});
process.on("SIGINT", reader.interrupt);

process.exit(
	await run(
		process.argv.slice(2),
		createContext({
			cwd: process.cwd(),
			model: modelFlag(process.argv),
			stdin: reader.read,
		}),
	),
);
