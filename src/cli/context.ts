import { join } from "node:path";
import { UsageError } from "../core/errors";
import { createLlm, type Llm } from "../llm/generate";

export interface CliContext {
	forgeDir: string;
	llm: Llm;
	readonly model: string;
	stdout: (line: string) => void;
	stdin: () => Promise<string>;
	/**
	 * Called once, right before an interactive pass starts asking
	 * questions — the one signal that arms "Ctrl+C ends the input"
	 * instead of exiting immediately (see `interruptible-stdin.ts`).
	 * `reviewCommand` calls it right before its review loop, on the
	 * interactive path only: `--all` asks nothing and never arms it.
	 * Undefined for a context nothing ever interrupts (most tests never
	 * need to supply it); `bin.ts` wires it to the real reader's
	 * `armEndOfInputOnInterrupt`.
	 */
	onInteractivePass?: () => void;
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
	/** See `CliContext.onInteractivePass`. */
	onInteractivePass?: () => void;
}

export function createContext(options: CreateContextOptions): CliContext {
	const environment = options.env ?? process.env;
	const forgeDirectory = join(options.cwd, ".forge");
	const model = options.model ?? environment.FORGE_MODEL;
	return {
		forgeDir: forgeDirectory,
		llm: createLlm({ forgeDir: forgeDirectory }),
		get model(): string {
			if (!model)
				throw new UsageError(
					"no model: pass --model provider/model or set FORGE_MODEL",
				);
			return model;
		},
		stdout: (line) => console.log(line),
		stdin: options.stdin,
		onInteractivePass: options.onInteractivePass,
	};
}
