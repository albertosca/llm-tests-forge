/**
 * Ctrl+C during `forge review` used to kill the process before the
 * write-back, and every decision of the pass went with it (measured
 * 2026-09-24, 43 cases). While the process is waiting for an answer, an
 * interrupt now ends the input instead: the pending read and every later
 * one answer "", which the review loop takes as `skip`, so the pass ends
 * normally and writes what was decided. Anywhere else — a model call, a
 * write — and on a second interrupt, it exits as Ctrl+C always did.
 */
export function createInterruptibleReader(args: {
	readLine: () => Promise<string>;
	stdout: (line: string) => void;
	exit: (code: number) => void;
}): { read: () => Promise<string>; interrupt: () => void } {
	let ended = false;
	let pending: ((line: string) => void) | null = null;
	return {
		read: () => {
			if (ended) return Promise.resolve("");
			return new Promise<string>((resolve) => {
				pending = resolve;
				args.readLine().then((line) => {
					if (pending === resolve) {
						pending = null;
						resolve(line);
					}
				});
			});
		},
		interrupt: () => {
			if (ended || pending === null) {
				args.exit(130);
				return;
			}
			ended = true;
			args.stdout(
				"interrupted: no more answers; the decisions already taken are written",
			);
			const resolve = pending;
			pending = null;
			resolve("");
		},
	};
}
