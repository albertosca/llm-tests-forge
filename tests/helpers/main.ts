import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterruptibleReader } from "../../src/cli/interruptible-stdin";
import { type MainOptions, main } from "../../src/cli/main";

/**
 * An empty directory under the run's private TMPDIR (see
 * tests/support/preload-temporary-root.ts), standing in for `~/.config`: a
 * test that does not name its own config directory loads no provider key,
 * rather than the developer's real ones.
 */
export const EMPTY_CONFIG_DIRECTORY = mkdtempSync(
	join(tmpdir(), "forge-no-keys-"),
);

/** `MainOptions` with the two entry-point wirings a test may leave out. */
export type TestMainOptions = Omit<
	MainOptions,
	"startInteractivePass" | "configDirectory"
> &
	Partial<Pick<MainOptions, "startInteractivePass" | "configDirectory">>;

/**
 * `main()` as the tests call it: keys from `EMPTY_CONFIG_DIRECTORY`, and
 * the interactive pass of a reader over the test's own `stdin`, unless the
 * test passes its own. The reader's `stdout` and `exit` are the real ones,
 * but nothing ever interrupts it, so neither is called.
 */
export function mainWithTestDefaults(
	argv: string[],
	options: TestMainOptions,
): Promise<number> {
	return main(argv, {
		startInteractivePass: createInterruptibleReader({
			readLine: options.stdin,
			stdout: console.log,
			exit: process.exit,
		}).startInteractivePass,
		configDirectory: EMPTY_CONFIG_DIRECTORY,
		...options,
	});
}
