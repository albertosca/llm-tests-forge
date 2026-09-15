import { join } from "node:path";
import { UsageError } from "../core/errors";
import { createLlm, type Llm } from "../llm/generate";

export interface CliContext {
	forgeDir: string;
	llm: Llm;
	readonly model: string;
	stdout: (line: string) => void;
	stdin: () => Promise<string>;
}

export interface CreateContextOptions {
	cwd: string;
	model?: string;
	env?: Record<string, string | undefined>;
	/**
	 * How to read one line of input. There is no real-terminal default
	 * here on purpose: reading a real line (via `console`'s async
	 * iterator) is I/O that only makes sense for the actual `forge`
	 * binary, so `src/cli/bin.ts` supplies that implementation and every
	 * test supplies its own scripted one.
	 */
	stdin: () => Promise<string>;
}

export function createContext(opts: CreateContextOptions): CliContext {
	const env = opts.env ?? process.env;
	const forgeDir = join(opts.cwd, ".forge");
	const model = opts.model ?? env.FORGE_MODEL;
	return {
		forgeDir,
		llm: createLlm({ forgeDir }),
		get model(): string {
			if (!model)
				throw new UsageError(
					"no model: pass --model provider/model or set FORGE_MODEL",
				);
			return model;
		},
		stdout: (line) => console.log(line),
		stdin: opts.stdin,
	};
}
