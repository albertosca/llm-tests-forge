import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { ForgeError } from "../../src/core/errors";
import { forgePaths } from "../../src/core/files";
import { createLlm } from "../../src/llm/generate";

const schema = z.object({ answer: z.number() });
const FAKE = "fake/tests/fixtures/fake-responses.json";

function mock(text: string) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 7, text: 7, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

async function tmpForge(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "forge-")), ".forge");
}

describe("createLlm.generate", () => {
	test("returns the validated object and usage, and appends to usage.jsonl", async () => {
		const dir = await tmpForge();
		const llm = createLlm({
			forgeDir: dir,
			resolve: () => mock('{"answer": 42}'),
			now: () => new Date("2026-09-14T10:00:00Z"),
		});
		const r = await llm.generate({
			schema,
			prompt: "p",
			model: "anthropic/x",
			verb: "probe",
		});
		expect(r.object).toEqual({ answer: 42 });
		expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
		const log = await readFile(forgePaths(dir).usage, "utf8");
		expect(JSON.parse(log.trim())).toEqual({
			ts: "2026-09-14T10:00:00.000Z",
			verb: "probe",
			model: "anthropic/x",
			inputTokens: 11,
			outputTokens: 7,
		});
	});

	test("saves raw text under failures/ and throws ForgeError with the path when output does not validate", async () => {
		const dir = await tmpForge();
		const llm = createLlm({
			forgeDir: dir,
			resolve: () => mock('{"answer": "not a number"}'),
			now: () => new Date("2026-09-14T10:00:00Z"),
		});
		const err = await llm
			.generate({ schema, prompt: "p", model: "anthropic/x", verb: "probe" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		const rawPath = (err as ForgeError).details.rawPath;
		expect(rawPath).toBe(
			join(forgePaths(dir).failuresDir, "probe-2026-09-14T10-00-00.000Z.txt"),
		);
		expect(await readFile(rawPath as string, "utf8")).toBe(
			'{"answer": "not a number"}',
		);
		expect(await readdir(forgePaths(dir).failuresDir)).toHaveLength(1);
	});

	test("fake provider picks the response by verb, in sequence for arrays", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		expect(
			(await llm.generate({ schema, prompt: "p", model: FAKE, verb: "probe" }))
				.object,
		).toEqual({ answer: 42 });
		expect(
			(
				await llm.generate({
					schema,
					prompt: "p",
					model: FAKE,
					verb: "sequence",
				})
			).object,
		).toEqual({ answer: 1 });
		expect(
			(
				await llm.generate({
					schema,
					prompt: "p",
					model: FAKE,
					verb: "sequence",
				})
			).object,
		).toEqual({ answer: 2 });
	});

	test("fake provider with a fenced response still fails loudly (generateObject does not strip fences)", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const err = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "broken" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			"did not match the broken schema",
		);
		const rawPath = (err as ForgeError).details.rawPath;
		expect(rawPath).toBeDefined();
		expect(await readFile(rawPath as string, "utf8")).toBe(
			'```json\n{"answer": 42}\n```',
		);
	});

	test("fake provider with an unknown verb throws ForgeError", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const err = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "nope" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain('no entry for verb "nope"');
		expect((err as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
		expect((err as ForgeError).details.rawPath).toBeUndefined();
	});

	test("fake provider names the file when the responses file has invalid JSON", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const malformed = "fake/tests/fixtures/fake-responses-malformed.txt";
		const err = await llm
			.generate({ schema, prompt: "p", model: malformed, verb: "probe" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("invalid JSON");
		expect((err as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses-malformed.txt",
		);
	});

	test("fake provider names the verb when a sequence entry is an empty array", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const err = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "empty" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain('entry for "empty" is empty');
		expect((err as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
	});

	test("fake provider rejects an entry that is neither a string nor an array of strings", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const err = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "wrong_type" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain(
			'entry for "wrong_type" must be a string or an array of strings',
		);
		expect((err as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
	});

	test("fake provider names the file when the responses file is missing", async () => {
		const dir = await tmpForge();
		const llm = createLlm({ forgeDir: dir });
		const missing = "fake/tests/fixtures/does-not-exist.json";
		const err = await llm
			.generate({ schema, prompt: "p", model: missing, verb: "probe" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("does-not-exist.json");
		expect((err as ForgeError).details.file).toBe(
			"tests/fixtures/does-not-exist.json",
		);
	});

	test("propagates errors other than NoObjectGeneratedError unwrapped", async () => {
		const dir = await tmpForge();
		const failingModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("network failure");
			},
		});
		const llm = createLlm({ forgeDir: dir, resolve: () => failingModel });
		const err = await llm
			.generate({ schema, prompt: "p", model: "anthropic/x", verb: "probe" })
			.catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(ForgeError);
		expect((err as Error).message).toBe("network failure");
	});
});
