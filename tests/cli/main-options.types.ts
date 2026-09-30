/**
 * A type-level test, checked by `bun run typecheck` and never run: the
 * file name is not `*.test.ts`, so `bun test` does not load it.
 *
 * An entry point that calls `main()` must say where the provider keys
 * live and hand over the interactive pass of the reader Ctrl+C is wired
 * to. Both were optional: forgetting `startInteractivePass` compiled and
 * left the first Ctrl+C of a review exiting at once, and forgetting
 * `configDirectory` silently read the real `~/.config`. Each
 * `@ts-expect-error` below fails the typecheck the day either one is
 * optional again.
 */
import { createInterruptibleReader } from "../../src/cli/interruptible-stdin";
import { main } from "../../src/cli/main";

const reader = createInterruptibleReader({
	readLine: async () => "",
	stdout: () => {},
	exit: () => {},
});

export function entryPointsMustWireBoth(): void {
	// @ts-expect-error startInteractivePass is required
	void main([], {
		cwd: ".",
		env: {},
		stdin: reader.read,
		configDirectory: ".",
	});
	// @ts-expect-error configDirectory is required
	void main([], {
		cwd: ".",
		env: {},
		stdin: reader.read,
		startInteractivePass: reader.startInteractivePass,
	});
}
