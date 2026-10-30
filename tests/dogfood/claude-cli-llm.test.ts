import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createClaudeCliLlm } from "../../scripts/dogfood/claude-cli-llm";
import { stubClaude } from "./stub-claude";

const schema = z.object({ label: z.string() });

const request = {
	schema,
	prompt: "classify this",
	model: "anthropic/claude-haiku-4-5",
	verb: "dogfood",
};

function envelope(result: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		result,
		usage: { input_tokens: 11, output_tokens: 7 },
		...extra,
	});
}

describe("createClaudeCliLlm", () => {
	test("runs the model the spec names, sends the prompt with the schema on stdin, and returns the parsed object and the usage", async () => {
		const stub = await stubClaude(envelope('{"label":"refund"}'));
		const llm = createClaudeCliLlm({
			command: stub.command,
			environment: { PATH: process.env.PATH },
		});
		const answer = await llm.generate(request);
		expect(answer).toEqual({
			object: { label: "refund" },
			usage: { inputTokens: 11, outputTokens: 7 },
		});
		const argumentList = (
			await readFile(join(stub.directory, "arguments"), "utf8")
		).split("\n");
		expect(argumentList.slice(0, 3)).toEqual([
			"-p",
			"--model",
			"claude-haiku-4-5",
		]);
		expect(argumentList).toContain("--no-session-persistence");
		const stdin = await readFile(join(stub.directory, "stdin"), "utf8");
		expect(stdin).toStartWith("classify this");
		expect(stdin).toContain('"required":["label"]');
	});
	test("takes the JSON object out of a reply wrapped in a code fence and a sentence", async () => {
		const stub = await stubClaude(
			envelope('Here it is:\n```json\n{"label":"status"}\n```'),
		);
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		expect((await llm.generate(request)).object).toEqual({ label: "status" });
	});
	test("an envelope without usage counts zero tokens", async () => {
		const stub = await stubClaude(JSON.stringify({ result: '{"label":"a"}' }));
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		expect((await llm.generate(request)).usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
		});
	});
	test("a reply that does not match the schema names the verb and the field", async () => {
		const stub = await stubClaude(envelope('{"label":3}'));
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		await expect(llm.generate(request)).rejects.toThrow(
			"did not match the dogfood schema: label",
		);
	});
	test("a reply with no JSON object, or a broken one, is refused", async () => {
		for (const [text, message] of [
			["no braces at all", "holds no JSON object"],
			["{not json}", "no valid JSON object"],
		] as const) {
			const stub = await stubClaude(envelope(text));
			const llm = createClaudeCliLlm({
				command: stub.command,
				environment: {},
			});
			await expect(llm.generate(request)).rejects.toThrow(message);
		}
	});
	test("an error envelope carries claude's own message", async () => {
		const stub = await stubClaude(envelope("rate limited", { is_error: true }));
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		await expect(llm.generate(request)).rejects.toThrow("claude: rate limited");
	});
	test("stdout that is not the envelope is refused", async () => {
		const stub = await stubClaude("plain text");
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		await expect(llm.generate(request)).rejects.toThrow(
			"not the JSON envelope",
		);
	});
	test("a non-zero exit reports the code and stderr", async () => {
		const stub = await stubClaude("", 3);
		const llm = createClaudeCliLlm({ command: stub.command, environment: {} });
		await expect(llm.generate(request)).rejects.toThrow(
			"claude exited 3: stub failure",
		);
	});
	test("only anthropic models are served, and nothing is run for another provider", async () => {
		const llm = createClaudeCliLlm({
			command: "/nonexistent/claude",
			environment: {},
		});
		await expect(
			llm.generate({ ...request, model: "google/gemini-3.5-flash" }),
		).rejects.toThrow(
			'serves only anthropic/ models, got "google/gemini-3.5-flash"',
		);
	});
	test("the defaults are the claude command and the process environment", () => {
		expect(typeof createClaudeCliLlm().generate).toBe("function");
	});
});
