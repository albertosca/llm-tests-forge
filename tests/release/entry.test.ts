import { describe, expect, test } from "bun:test";
import { runMain, runScript } from "../../scripts/release/entry";
import { ForgeError, UsageError } from "../../src/core/errors";

describe("runScript", () => {
	test("passes the exit code through", async () => {
		expect(
			await runScript(
				async () => 7,
				() => {},
			),
		).toBe(7);
	});

	test("a failure prints its message and exits 1; a bad command line exits 2", async () => {
		const printed: string[] = [];
		const print = (line: string) => printed.push(line);
		expect(
			await runScript(async () => {
				throw new ForgeError("broke", { file: "a.txt" });
			}, print),
		).toBe(1);
		expect(
			await runScript(async () => {
				throw new UsageError("usage: x");
			}, print),
		).toBe(2);
		expect(printed).toEqual(["error: broke (file: a.txt)", "error: usage: x"]);
	});

	test("runMain does nothing when the file is only imported", async () => {
		const exits: number[] = [];
		await runMain(
			false,
			async () => 0,
			[],
			() => {},
			(code) => exits.push(code),
		);
		expect(exits).toEqual([]);
	});

	test("runMain runs on the given arguments, prints through the given printer, and exits with the code", async () => {
		const printed: string[] = [];
		const exits: number[] = [];
		await runMain(
			true,
			async (argumentsList, print) => {
				print(argumentsList.join(","));
				return 3;
			},
			["a", "b"],
			(line) => printed.push(line),
			(code) => exits.push(code),
		);
		expect({ printed, exits }).toEqual({ printed: ["a,b"], exits: [3] });
	});

	test("an unexpected error is not swallowed", async () => {
		await expect(
			runScript(
				async () => {
					throw new TypeError("bug");
				},
				() => {},
			),
		).rejects.toThrow("bug");
	});
});
