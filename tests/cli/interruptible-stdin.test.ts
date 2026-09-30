import { describe, expect, test } from "bun:test";
import { createInterruptibleReader } from "../../src/cli/interruptible-stdin";

/** A line source that answers only when told to. */
function pendingLines() {
	const waiting: ((line: string) => void)[] = [];
	return {
		readLine: () => new Promise<string>((resolve) => waiting.push(resolve)),
		answer: (line: string) => waiting.shift()?.(line),
	};
}

describe("createInterruptibleReader", () => {
	test("passes lines through while nothing is interrupted", async () => {
		const source = pendingLines();
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: () => {},
			exit: () => {},
		});
		const answer = reader.read();
		source.answer("approve");
		expect(await answer).toBe("approve");
	});

	test("unarmed: an interrupt with a read pending exits 130, without ending the input", () => {
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: pendingLines().readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		reader.read();
		reader.interrupt();
		expect(exits).toEqual([130]);
		expect(printed).toEqual([]);
	});

	test("unarmed: an interrupt after a completed read, with none pending, exits 130 -- the `llm-tests-forge describe` case: one read for the free text, then a model call, never armed because describe is not an interactive review pass", async () => {
		const source = pendingLines();
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: () => {},
			exit: (code) => exits.push(code),
		});
		const answer = reader.read();
		source.answer("a hiring email");
		expect(await answer).toBe("a hiring email");
		// The free text is in; the process is now inside the model call.
		// Round 1 armed end-of-input as soon as any read had happened,
		// which printed the end-of-input message here and did not stop --
		// only a second Ctrl+C did (task review 2026-09-28). Never armed
		// here, so the very first interrupt exits, as it always did.
		reader.interrupt();
		expect(exits).toEqual([130]);
	});

	test("startInteractivePass arms the handler, and the reader it hands over reads through the same input", async () => {
		const source = pendingLines();
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		const pass = reader.startInteractivePass();
		const first = pass.read();
		source.answer("approve");
		expect(await first).toBe("approve");
		const second = pass.read();
		reader.interrupt();
		expect(await second).toBe("");
		expect(await reader.read()).toBe("");
		expect(exits).toEqual([]);
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
	});

	test("armed: an interrupt with no read pending ends the input", async () => {
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: pendingLines().readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		reader.startInteractivePass();
		reader.interrupt();
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
		expect(exits).toEqual([]);
		expect(await reader.read()).toBe("");
	});

	test("armed: an interrupt with a read pending ends the input: the pending read and every later read answer empty, and it says so once", async () => {
		const source = pendingLines();
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		reader.startInteractivePass();
		const answer = reader.read();
		reader.interrupt();
		expect(await answer).toBe("");
		expect(await reader.read()).toBe("");
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
		expect(exits).toEqual([]);
	});

	test("armed: an interrupt after a completed read, with none pending (the $EDITOR case), ends the input: no exit, the line printed once, the next read answers empty", async () => {
		const source = pendingLines();
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		reader.startInteractivePass();
		const answer = reader.read();
		source.answer("edit");
		expect(await answer).toBe("edit");
		// The person is now inside $EDITOR: read() already resolved, and
		// nothing has called it again yet -- exactly the gap where the old
		// "no read pending" rule exited, throwing away the "edit" decision
		// above along with everything already approved this pass.
		reader.interrupt();
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
		expect(exits).toEqual([]);
		expect(await reader.read()).toBe("");
	});

	test("armed: a second interrupt exits 130 even after the first ended the input", async () => {
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: pendingLines().readLine,
			stdout: () => {},
			exit: (code) => exits.push(code),
		});
		reader.startInteractivePass();
		const answer = reader.read();
		reader.interrupt();
		await answer;
		reader.interrupt();
		expect(exits).toEqual([130]);
	});
});
