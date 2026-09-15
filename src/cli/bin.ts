#!/usr/bin/env bun
import { createContext } from "./context";
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

process.exit(
	await run(
		process.argv.slice(2),
		createContext({
			cwd: process.cwd(),
			model: modelFlag(process.argv),
			stdin: readStdinLine,
		}),
	),
);
