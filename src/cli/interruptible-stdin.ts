/**
 * Ctrl+C during `forge review` used to kill the process before the
 * write-back, and every decision of the pass went with it (measured
 * 2026-09-24, 43 cases). Once the process has called `read()` at least
 * once — it is asking an interactive question — the first interrupt ends
 * the input instead of exiting: it happens whether or not a read is
 * pending right then, because a person can be inside `$EDITOR` (or
 * otherwise between two reads) when they press Ctrl+C, and that decision
 * must survive too (found under task review 2026-09-28: interrupting
 * `$EDITOR` took the "no read pending" branch and exited 130, losing the
 * whole pass, including everything already approved). A pending read, if
 * there is one, and every later read answer "", which the review loop
 * takes as `skip`, so the pass ends normally and writes what was decided.
 * A process that never called `read()` at all — `cases`, `emit`, any
 * command with no question to end — still exits on its first interrupt,
 * since there is no pass to end. A second interrupt always exits, as
 * Ctrl+C always did.
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
}): { read: () => Promise<string>; interrupt: () => void } {
	let ended = false;
	let hasCalledRead = false;
	let pending: ((line: string) => void) | null = null;
	return {
		read: () => {
			hasCalledRead = true;
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
		interrupt: () => {
			if (ended || !hasCalledRead) {
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
