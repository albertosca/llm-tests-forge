import { join } from "node:path";
import { UsageError } from "../core/errors";
import type { readSuiteIfPresent } from "../core/files";
import type { Project } from "../core/project";
import { createLlm, type Llm } from "../llm/generate";

export interface CliContext {
	/** The directory the command was run from. */
	cwd: string;
	forgeDirectory: string;
	/** The forge.yaml the suite belongs to, or null outside a project. */
	project: Project | null;
	llm: Llm;
	readonly drafter: string;
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
	/**
	 * How the version warning reads suite.yaml; absent -> the real reader.
	 * A seam for tests, to prove which failures the warning swallows.
	 */
	readSuiteIfPresent?: typeof readSuiteIfPresent;
}

export interface CreateContextOptions {
	cwd: string;
	drafter?: string;
	/** The suite's `.forge`; absent -> `<cwd>/.forge`. */
	forgeDirectory?: string;
	/** The project the suite belongs to; absent -> none. */
	project?: Project | null;
	env?: Record<string, string | undefined>;
	/**
	 * How to read one line of input. There is no real-terminal default
	 * here on purpose: reading a real line (via `console`'s async
	 * iterator) is I/O that only makes sense for the actual `llm-tests-forge`
	 * binary, so `src/cli/bin.ts` supplies that implementation and every
	 * test supplies its own scripted one.
	 */
	stdin: () => Promise<string>;
	/** See `CliContext.onInteractivePass`. */
	onInteractivePass?: () => void;
}

export function createContext(options: CreateContextOptions): CliContext {
	const environment = options.env ?? process.env;
	const forgeDirectory = options.forgeDirectory ?? join(options.cwd, ".forge");
	const project = options.project ?? null;
	// An empty FORGE_DRAFTER="" is unset, not a choice: it must not hide defaults.drafter.
	const drafter =
		options.drafter ??
		(environment.FORGE_DRAFTER || undefined) ??
		project?.config.defaults.drafter;
	return {
		cwd: options.cwd,
		forgeDirectory,
		project,
		llm: createLlm({ forgeDirectory }),
		get drafter(): string {
			if (!drafter)
				throw new UsageError(
					"no drafter: pass --drafter provider/model, set FORGE_DRAFTER, or set defaults.drafter in forge.yaml",
				);
			return drafter;
		},
		stdout: (line) => console.log(line),
		stdin: options.stdin,
		onInteractivePass: options.onInteractivePass,
	};
}
