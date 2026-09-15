/**
 * Retry-with-classification for the live smoke test. Extracted out of
 * `describe-scenarios.live.test.ts` into its own module (rather than kept
 * as a local function inside that test file) so it can be unit-tested
 * offline with a fake `attempt`, with no network and no `FORGE_LIVE` gate
 * hiding it from `bun test`'s coverage report -- see `retry.test.ts`.
 *
 * This lives under `tests/live/`, not `src/`, because it is smoke-test
 * infrastructure, not something `forge`'s own CLI ships or calls; `src/`
 * stays exclusively the product surface consumed by `src/cli/bin.ts`.
 */

export interface AttemptResult {
	/** The forge CLI's own exit code for this attempt (0 = success). */
	code: number;
	/** The last line `run()` printed -- for a non-zero exit, this is the
	 * clean `error: ...` message `run()`'s own classification guarantees
	 * (see `src/cli/main.ts`), which is exactly what this module pattern-
	 * matches to decide whether the failure was transient. */
	message: string;
}

export interface RetryConfig {
	maxAttempts: number;
	/** Matches only the provider's own transient-overload signal (503 /
	 * UNAVAILABLE / "high demand"), never a 429 quota error, an auth
	 * failure, an unknown-model error, or a schema-validation failure --
	 * those must fail immediately, not be mistaken for "the provider is
	 * busy". */
	transientPattern: RegExp;
	delayMs: number;
	sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	transientPattern: /\b(503|unavailable|high demand)\b/i,
	delayMs: 3_000,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `attempt` up to `config.maxAttempts` times, retrying only when the
 * failure's message matches `config.transientPattern`. Any other non-zero
 * result fails immediately (attempt 1, no retry) with a message that names
 * it as a likely real defect; exhausting every attempt on a transient
 * failure fails with a message that names the provider as the cause
 * instead -- the two are deliberately worded so a reader can tell "the
 * provider was busy" from "the code is broken" without reading a stack
 * trace, and a genuine programming error thrown by `attempt` itself is
 * never caught here, so it propagates with its real stack unchanged.
 */
export async function retryTransient(
	label: string,
	attempt: () => Promise<AttemptResult>,
	config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<void> {
	for (let n = 1; n <= config.maxAttempts; n++) {
		const { code, message } = await attempt();
		if (code === 0) return;
		if (!config.transientPattern.test(message))
			throw new Error(
				`${label} failed with a non-transient error on attempt ${n}/${config.maxAttempts} (not retried -- this looks like a real defect, not the provider being busy): ${message}`,
			);
		if (n === config.maxAttempts)
			throw new Error(
				`${label} was still a transient provider-overload failure after ${config.maxAttempts} attempts (the provider was busy, not the code): ${message}`,
			);
		await config.sleep(config.delayMs);
	}
}
