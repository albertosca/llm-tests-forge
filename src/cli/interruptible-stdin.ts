/**
 * Ctrl+C during `llm-tests-forge review` used to kill the process before the
 * write-back, and every decision of the pass went with it (measured
 * 2026-09-24, 43 cases). "End of input" mode changes what an interrupt
 * does: unarmed, an interrupt exits — the behaviour every command had
 * before this file existed, and still has by default. Once
 * `startInteractivePass()` has been called, the first interrupt instead
 * ends the input: it happens whether or not a read is pending right then,
 * because a person can be inside `$EDITOR` (or otherwise between two
 * reads) when they press Ctrl+C, and that decision must survive too. A
 * pending read, if there is one, and every later read answer "", which the
 * review loop takes as `skip`, so the pass ends normally and writes what
 * was decided. A second interrupt exits, armed or not, as Ctrl+C always
 * did — except during the write-back (`whileWriting`), where it lets the
 * write finish and then exits 130.
 *
 * Arming has to be a separate call, not "after the first `read()`": task
 * review 2026-09-28 found that `llm-tests-forge describe` calls `read()` once for
 * its free text and then calls the model — under the "has read once"
 * rule, a Ctrl+C during that model call printed the end-of-input message
 * and did not stop the process; only a second Ctrl+C did. `reviewCommand`
 * is the only caller that arms it, and only on the interactive path
 * (`review --all` asks nothing and never arms it).
 *
 * Arming is also enforced by the type system: the questions a review pass
 * asks (`askChoice`, `askExpectedFor`) take an `InteractiveReader`, and the
 * only way to get one is `startInteractivePass()`, which arms the handler
 * as it hands the reader over. A caller that forgot to arm used to compile
 * and lose the whole pass to the first Ctrl+C.
 *
 * One loose end, left as-is rather than fixed: the `readLine()` call
 * behind the read `interrupt()` ended keeps waiting on the real stdin
 * after `interrupt()` returns — nothing cancels it. This is harmless in
 * practice: `bin.ts` calls `process.exit()` once `run()` returns, which
 * ends the process (and that dangling read) along with it.
 */

const interactiveBrand: unique symbol = Symbol("interactive reader");

/**
 * A line reader whose interactive pass has been started, so an interrupt
 * ends the input instead of the process. Only `startInteractivePass()`
 * makes one.
 */
export type InteractiveReader = (() => Promise<string>) & {
	readonly [interactiveBrand]: true;
	/**
	 * Whether a Ctrl+C has ended the input. Every read then answers "",
	 * which a question that re-asks an empty answer must not mistake for
	 * one: it asks this instead of printing "try again".
	 */
	readonly inputEnded: () => boolean;
};

/** What `startInteractivePass()` hands the review: the armed reader. */
export interface InteractivePass {
	read: InteractiveReader;
	whileWriting<Result>(work: () => Promise<Result>): Promise<Result>;
}

export interface InterruptibleReader {
	/** A plain read, for a single question that is not an interactive pass. */
	read: () => Promise<string>;
	interrupt: () => void;
	/** Arms end-of-input mode and returns the pass's armed reader. */
	startInteractivePass: () => InteractivePass;
}

export function createInterruptibleReader(dependencies: {
	readLine: () => Promise<string>;
	stdout: (line: string) => void;
	exit: (code: number) => void;
}): InterruptibleReader {
	let ended = false;
	let armed = false;
	let pending: ((line: string) => void) | null = null;
	const read = (): Promise<string> => {
		if (ended) return Promise.resolve("");
		return new Promise<string>((resolve) => {
			pending = resolve;
			dependencies.readLine().then((line) => {
				if (pending === resolve) {
					pending = null;
					resolve(line);
				}
			});
		});
	};
	const brand: { readonly [interactiveBrand]: true } = {
		[interactiveBrand]: true,
	};
	const interactiveRead: InteractiveReader = Object.assign(
		(): Promise<string> => read(),
		brand,
		{ inputEnded: (): boolean => ended },
	);
	let writing = false;
	let exitAfterWriting = false;
	/**
	 * A second Ctrl+C used to exit wherever it landed, including in the
	 * middle of the write-back — leaving one file written and the next not,
	 * or a file half-written. During `work` it is held instead: the write
	 * finishes, then the process exits 130 (owner decision, 2026-09-29).
	 * A write that fails is not followed by the exit: its error is what
	 * the person needs to read, and the caller reports it.
	 */
	const whileWriting = async <Result>(
		work: () => Promise<Result>,
	): Promise<Result> => {
		writing = true;
		let result: Result;
		try {
			result = await work();
		} finally {
			writing = false;
		}
		if (exitAfterWriting) dependencies.exit(130);
		return result;
	};
	return {
		read,
		startInteractivePass: () => {
			armed = true;
			return { read: interactiveRead, whileWriting };
		},
		interrupt: () => {
			if (ended && writing) {
				exitAfterWriting = true;
				return;
			}
			if (ended || !armed) {
				dependencies.exit(130);
				return;
			}
			ended = true;
			dependencies.stdout(
				"interrupted: no more answers; the decisions already taken are written",
			);
			if (pending !== null) {
				const resolve = pending;
				pending = null;
				resolve("");
			}
		},
	};
}
