import { UsageError } from "../core/errors";

/**
 * Shared by every CLI command that takes a count flag (`--n`, `--more`):
 * `undefined` when the flag was not passed, the parsed number when it is a
 * positive integer, and a `UsageError` naming the flag and the raw value
 * otherwise -- a bad count is a command-line mistake, not a runtime failure.
 */
export function parsePositiveIntFlag(
	flag: string,
	raw: string | undefined,
): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0)
		throw new UsageError(
			`${flag} "${raw}" is not valid; expected a positive integer`,
		);
	return n;
}
