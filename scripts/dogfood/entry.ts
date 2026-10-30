import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageOf } from "../../src/core/errors";
import {
	defaultConfigDirectory,
	loadProviderKeys,
} from "../../src/llm/credentials";
import { createLlm, type Llm } from "../../src/llm/generate";
import { type ExecInvocation, parseExecArguments } from "./exec-arguments";

export type Handler = (invocation: ExecInvocation, llm: Llm) => Promise<string>;

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
	configDirectory: string = defaultConfigDirectory(),
): Promise<number> {
	const forgeDirectory = await mkdtemp(join(tmpdir(), "forge-dogfood-"));
	try {
		const invocation = parseExecArguments(argumentList);
		const llm = createLlm({
			forgeDirectory,
			beforeResolve: async () => {
				await loadProviderKeys({
					environment: process.env,
					configDirectory,
				});
			},
		});
		sinks.stdout(`${await handler(invocation, llm)}\n`);
		return 0;
	} catch (error) {
		sinks.stderr(`${messageOf(error)}\n`);
		return 1;
	} finally {
		await rm(forgeDirectory, { recursive: true, force: true });
	}
}
