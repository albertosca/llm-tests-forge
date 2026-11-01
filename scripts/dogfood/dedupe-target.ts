#!/usr/bin/env bun
import { runDedupe } from "./dedupe-run";
import { runTarget } from "./entry";

process.exitCode = await runTarget(
	runDedupe,
	process.argv.slice(2),
	{
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	},
	{
		transport:
			process.env.DOGFOOD_TRANSPORT === "claude-cli" ? "claude-cli" : "api",
	},
);
