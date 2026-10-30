import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDedupe } from "../../scripts/dogfood/dedupe-run";
import { runTarget } from "../../scripts/dogfood/entry";
import { stubClaude } from "./stub-claude";

const options = JSON.stringify({ config: { model: "fake/none" } });

function capture() {
	const printed: string[] = [];
	const failures: string[] = [];
	return {
		printed,
		failures,
		sinks: {
			stdout: (text: string) => printed.push(text),
			stderr: (text: string) => failures.push(text),
		},
	};
}

describe("runTarget", () => {
	test("prints the handler's answer as one line on stdout and exits 0", async () => {
		const captured = capture();
		const code = await runTarget(
			async (invocation) => `{"model":"${invocation.model}"}`,
			["p", options, "{}"],
			captured.sinks,
		);
		expect(code).toBe(0);
		expect(captured.printed).toEqual(['{"model":"fake/none"}\n']);
		expect(captured.failures).toEqual([]);
	});
	test("a failure is one line on stderr, nothing on stdout, exit 1", async () => {
		const captured = capture();
		const code = await runTarget(
			async () => {
				throw new Error("boom");
			},
			["p", options, "{}"],
			captured.sinks,
		);
		expect(code).toBe(1);
		expect(captured.printed).toEqual([]);
		expect(captured.failures).toEqual(["boom\n"]);
	});
	test("bad arguments fail the same way, before any model is touched", async () => {
		const captured = capture();
		const code = await runTarget(async () => "x", [], captured.sinks);
		expect(code).toBe(1);
		expect(captured.failures[0]).toContain("three arguments");
	});
	test("a real provider reads the key files from the config directory, and with none the failure names the variable", async () => {
		const configDirectory = await mkdtemp(
			join(tmpdir(), "forge-entry-config-"),
		);
		const saved = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const captured = capture();
			const code = await runTarget(
				runDedupe,
				[
					"p",
					JSON.stringify({ config: { model: "anthropic/claude-haiku-4-5" } }),
					JSON.stringify({
						vars: {
							cases:
								"- id: c1\n  input: { message: a }\n  expected: { label: x }\n- id: c2\n  input: { message: b }\n  expected: { label: x }\n",
						},
					}),
				],
				captured.sinks,
				{ configDirectory },
			);
			expect(code).toBe(1);
			expect(captured.printed).toEqual([]);
			expect(captured.failures.join("")).toContain("ANTHROPIC_API_KEY");
		} finally {
			if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
		}
	});
	test("the claude-cli transport runs the handler against the claude executable and never touches the API", async () => {
		const stub = await stubClaude(
			JSON.stringify({
				result: '{"duplicates":[{"id":"c2","duplicate_of":"c1"}]}',
			}),
		);
		const captured = capture();
		const code = await runTarget(
			runDedupe,
			[
				"p",
				JSON.stringify({ config: { model: "anthropic/claude-haiku-4-5" } }),
				JSON.stringify({
					vars: {
						cases:
							"- id: c1\n  input: { message: a }\n  expected: { label: x }\n- id: c2\n  input: { message: b }\n  expected: { label: x }\n",
					},
				}),
			],
			captured.sinks,
			{ transport: "claude-cli", claudeCommand: stub.command },
		);
		expect(code).toBe(0);
		expect(JSON.parse(captured.printed.join(""))).toEqual({
			duplicates: [{ id: "c2", duplicate_of: "c1" }],
		});
	});
});
