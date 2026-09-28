/**
 * Ctrl+C during `llm-tests-forge review` used to kill the process before the
 * write-back, and every decision of the pass went with it (measured
 * 2026-09-24, 43 cases). "End of input" mode changes what an interrupt
 * does: unarmed, an interrupt exits — the behaviour every command had
 * before this file existed, and still has by default. Once
 * `armEndOfInputOnInterrupt()` has been called, the first interrupt
 * instead ends the input: it happens whether or not a read is pending
 * right then, because a person can be inside `$EDITOR` (or otherwise
 * between two reads) when they press Ctrl+C, and that decision must
 * survive too. A pending read, if there is one, and every later read
 * answer "", which the review loop takes as `skip`, so the pass ends
 * normally and writes what was decided. A second interrupt always exits,
 * armed or not, as Ctrl+C always did.
 *
 * Arming has to be a separate call, not "after the first `read()`": task
 * review 2026-09-28 found that `llm-tests-forge describe` calls `read()` once for
 * its free text and then calls the model — under the "has read once"
 * rule, a Ctrl+C during that model call printed the end-of-input message
 * and did not stop the process; only a second Ctrl+C did. `reviewCommand`
 * is the only caller that arms it, and only on the interactive path
 * (`review --all` asks nothing and never arms it) — see
 * `CliContext.onInteractivePass`.
 *
 * One loose end, left as-is rather than fixed: the `readLine()` call
 * behind the read `interrupt()` ended keeps waiting on the real stdin
 * after `interrupt()` returns — nothing cancels it. This is harmless in
 * practice: `bin.ts` calls `process.exit()` once `run()` returns, which
 * ends the process (and that dangling read) along with it.
 */
export function createInterruptibleReader(dependencies: {
	readLine: () => Promise<string>;
	stdout: (line: string) => void;
	exit: (code: number) => void;
}): {
	read: () => Promise<string>;
	interrupt: () => void;
	armEndOfInputOnInterrupt: () => void;
} {
	let ended = false;
	let armed = false;
	let pending: ((line: string) => void) | null = null;
	return {
		read: () => {
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
		},
		armEndOfInputOnInterrupt: () => {
			armed = true;
		},
		interrupt: () => {
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
