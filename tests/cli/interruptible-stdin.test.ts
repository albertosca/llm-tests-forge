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

	test("an interrupt while waiting ends the input: the pending read and every later read answer empty, and it says so once", async () => {
		const source = pendingLines();
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		const answer = reader.read();
		reader.interrupt();
		expect(await answer).toBe("");
		expect(await reader.read()).toBe("");
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
		expect(exits).toEqual([]);
	});

	test("an interrupt before any read exits 130: cases and emit never call read, so there is no pass to end", () => {
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: pendingLines().readLine,
			stdout: () => {},
			exit: (code) => exits.push(code),
		});
		reader.interrupt();
		expect(exits).toEqual([130]);
	});

	test("an interrupt after a completed read, with none pending (the editor case), ends the input: no exit, the line printed once, the next read answers empty", async () => {
		const source = pendingLines();
		const printed: string[] = [];
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: source.readLine,
			stdout: (line) => printed.push(line),
			exit: (code) => exits.push(code),
		});
		const answer = reader.read();
		source.answer("edit");
		expect(await answer).toBe("edit");
		// The person is now inside $EDITOR: read() already resolved, and
		// nothing has called it again yet -- exactly the gap where the old
		// rule saw no pending read and exited, throwing away the "edit"
		// decision above along with everything already approved this pass.
		reader.interrupt();
		expect(printed).toEqual([
			"interrupted: no more answers; the decisions already taken are written",
		]);
		expect(exits).toEqual([]);
		expect(await reader.read()).toBe("");
	});

	test("a second interrupt exits 130 even after the first ended the input", async () => {
		const exits: number[] = [];
		const reader = createInterruptibleReader({
			readLine: pendingLines().readLine,
			stdout: () => {},
			exit: (code) => exits.push(code),
		});
		const answer = reader.read();
		reader.interrupt();
		await answer;
		reader.interrupt();
		expect(exits).toEqual([130]);
	});
});
