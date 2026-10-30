#!/usr/bin/env bun
import { runTarget } from "./entry";
import { runScenarios } from "./scenarios-run";

process.exitCode = await runTarget(
	runScenarios,
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
