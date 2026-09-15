import { describe, expect, test } from "bun:test";
import {
	type AttemptResult,
	DEFAULT_RETRY_CONFIG,
	type RetryConfig,
	retryTransient,
} from "./retry";

function fakeSleep() {
	const calls: number[] = [];
	const sleep = async (ms: number) => {
		calls.push(ms);
	};
	return { sleep, calls };
}

function fakeAttempts(...results: AttemptResult[]) {
	let calls = 0;
	return {
		attempt: async (): Promise<AttemptResult> => {
			const r = results[calls];
			calls += 1;
			if (!r)
				throw new Error("fakeAttempts called more times than results provided");
			return r;
		},
		callCount: () => calls,
	};
}

describe("retryTransient", () => {
	test("retries a transient failure and returns after eventual success (attempt count, not just that it resolved)", async () => {
		const { sleep, calls: sleepCalls } = fakeSleep();
		const { attempt, callCount } = fakeAttempts(
			{
				code: 1,
				message: "error: This model is currently experiencing high demand.",
			},
			{ code: 1, message: "error: 503 UNAVAILABLE" },
			{
				code: 0,
				message: 'describe: feature "x" written as pending -> ...',
			},
		);
		const config: RetryConfig = {
			maxAttempts: 3,
			transientPattern: DEFAULT_RETRY_CONFIG.transientPattern,
			delayMs: 3_000,
			sleep,
		};

		await retryTransient("`forge describe`", attempt, config);

		expect(callCount()).toBe(3);
		expect(sleepCalls).toEqual([3_000, 3_000]);
	});

	test("succeeds on the very first attempt with the default config (no retry, no sleep)", async () => {
		const { attempt, callCount } = fakeAttempts({
			code: 0,
			message: "describe: feature written as pending",
		});

		await retryTransient("`forge describe`", attempt, DEFAULT_RETRY_CONFIG);

		expect(callCount()).toBe(1);
	});

	test("exhausts all attempts on a persistently transient failure and names the provider as the cause, not the code", async () => {
		const { sleep, calls: sleepCalls } = fakeSleep();
		const { attempt, callCount } = fakeAttempts(
			{ code: 1, message: "error: high demand" },
			{ code: 1, message: "error: 503" },
			{ code: 1, message: "error: still unavailable" },
		);
		const config: RetryConfig = {
			maxAttempts: 3,
			transientPattern: DEFAULT_RETRY_CONFIG.transientPattern,
			delayMs: 10,
			sleep,
		};

		let err: unknown;
		try {
			await retryTransient("`forge scenarios`", attempt, config);
		} catch (e) {
			err = e;
		}

		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toContain(
			"was still a transient provider-overload failure after 3 attempts",
		);
		expect(message).toContain("the provider was busy, not the code");
		// The two exhaustion messages must stay distinguishable -- a message
		// that could pass for either tells a reader nothing.
		expect(message).not.toContain("real defect");
		expect(callCount()).toBe(3);
		expect(sleepCalls).toEqual([10, 10]);
	});

	test("fails immediately on a non-transient failure, naming it as a likely real defect, without retrying", async () => {
		const { sleep, calls: sleepCalls } = fakeSleep();
		const { attempt, callCount } = fakeAttempts(
			{ code: 1, message: "error: GOOGLE_API_KEY is not set." },
			{ code: 0, message: "this attempt must never be reached" },
		);
		const config: RetryConfig = {
			maxAttempts: 3,
			transientPattern: DEFAULT_RETRY_CONFIG.transientPattern,
			delayMs: 10,
			sleep,
		};

		let err: unknown;
		try {
			await retryTransient("`forge describe`", attempt, config);
		} catch (e) {
			err = e;
		}

		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toContain(
			"failed with a non-transient error on attempt 1/3",
		);
		expect(message).toContain(
			"this looks like a real defect, not the provider being busy",
		);
		// The two exhaustion messages must stay distinguishable in both
		// directions.
		expect(message).not.toContain("provider was busy, not the code");
		expect(callCount()).toBe(1);
		expect(sleepCalls).toEqual([]);
	});

	test("a non-positive maxAttempts never calls attempt and resolves without error", async () => {
		// A misconfigured RetryConfig ({ maxAttempts: 0 }) is a real,
		// reachable state for a public field of an exported config -- not a
		// defensive test for something impossible. With no attempts
		// configured, the loop body never runs, so the function returns via
		// its natural fall-through rather than an early `return`/`throw`.
		const { attempt, callCount } = fakeAttempts({
			code: 0,
			message: "must never be reached",
		});
		const config: RetryConfig = {
			maxAttempts: 0,
			transientPattern: DEFAULT_RETRY_CONFIG.transientPattern,
			delayMs: 10,
			sleep: async () => {},
		};

		await retryTransient("`forge describe`", attempt, config);

		expect(callCount()).toBe(0);
	});
});

describe("DEFAULT_RETRY_CONFIG.sleep", () => {
	test("actually waits close to the requested delay, rather than resolving synchronously", async () => {
		const before = Date.now();
		await DEFAULT_RETRY_CONFIG.sleep(20);
		// A real timer, not `Promise.resolve()` dressed up as one -- a
		// tolerant floor (well under the requested 20ms) avoids flaking on
		// a busy CI box while still catching a sleep that does nothing.
		expect(Date.now() - before).toBeGreaterThanOrEqual(10);
	});
});
