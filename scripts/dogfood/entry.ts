import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageOf } from "../../src/core/errors";
import {
	defaultConfigDirectory,
	loadProviderKeys,
} from "../../src/llm/credentials";
import { createLlm, type Llm } from "../../src/llm/generate";
import { createClaudeCliLlm } from "./claude-cli-llm";
import { type ExecInvocation, parseExecArguments } from "./exec-arguments";

export type Handler = (invocation: ExecInvocation, llm: Llm) => Promise<string>;

export interface TargetOptions {
	/** Where the provider key files live; the home directory's `.config` by default. */
	configDirectory?: string;
	/** `claude-cli` reaches the model through the Claude Code CLI (subscription quota) instead of the API. */
	transport?: "api" | "claude-cli";
	claudeCommand?: string;
	/** Where the claude-cli transport logs each call's usage; `DOGFOOD_USAGE_FILE` by default. */
	usageFile?: string;
	/** Where the throwaway directory is made; the system temp directory by default. */
	temporaryRoot?: string;
}

export interface Sinks {
	stdout(text: string): void;
	stderr(text: string): void;
}

/**
 * The shared body of every dogfood target: parse promptfoo's exec arguments,
 * build the production model client (provider keys read from the same files
 * the CLI reads), run the handler and print its one JSON line. Everything
 * else goes to stderr, which is what promptfoo shows on an error row. The
 * client writes its usage log into a throwaway directory, not the repository.
 */
export async function runTarget(
	handler: Handler,
	argumentList: string[],
	sinks: Sinks,
	options: TargetOptions = {},
): Promise<number> {
	const forgeDirectory = await mkdtemp(
		join(options.temporaryRoot ?? tmpdir(), "forge-dogfood-"),
	);
	let succeeded = false;
	try {
		const invocation = parseExecArguments(argumentList);
		const llm =
			options.transport === "claude-cli"
				? createClaudeCliLlm({
						command: options.claudeCommand,
						usageFile: options.usageFile ?? process.env.DOGFOOD_USAGE_FILE,
					})
				: createLlm({
						forgeDirectory,
						beforeResolve: async () => {
							await loadProviderKeys({
								environment: process.env,
								configDirectory:
									options.configDirectory ?? defaultConfigDirectory(),
							});
						},
					});
		sinks.stdout(`${await handler(invocation, llm)}\n`);
		succeeded = true;
		return 0;
	} catch (error) {
		sinks.stderr(`${messageOf(error)}\n`);
		return 1;
	} finally {
		// A failure may name a file inside it (the raw model output), so it stays.
		if (succeeded) await rm(forgeDirectory, { recursive: true, force: true });
	}
}
