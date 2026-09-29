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
		const directory = await tmpForge();
		const llm = createLlm({
			forgeDirectory: directory,
			resolve: () => mock('{"answer": 42}'),
			now: () => new Date("2026-09-14T10:00:00Z"),
		});
		const result = await llm.generate({
			schema,
			prompt: "p",
			model: "anthropic/x",
			verb: "probe",
		});
		expect(result.object).toEqual({ answer: 42 });
		expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
		const log = await readFile(forgePaths(directory).usage, "utf8");
		expect(JSON.parse(log.trim())).toEqual({
			ts: "2026-09-14T10:00:00.000Z",
			verb: "probe",
			model: "anthropic/x",
			inputTokens: 11,
			outputTokens: 7,
		});
	});

	test("saves raw text under failures/ and throws ForgeError with the path when output does not validate", async () => {
		const directory = await tmpForge();
		const llm = createLlm({
			forgeDirectory: directory,
			resolve: () => mock('{"answer": "not a number"}'),
			now: () => new Date("2026-09-14T10:00:00Z"),
		});
		const failure = await llm
			.generate({ schema, prompt: "p", model: "anthropic/x", verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		const rawPath = (failure as ForgeError).details.rawPath;
		expect(rawPath).toBe(
			join(
				forgePaths(directory).failuresDir,
				"probe-2026-09-14T10-00-00.000Z.txt",
			),
		);
		expect(await readFile(rawPath as string, "utf8")).toBe(
			'{"answer": "not a number"}',
		);
		expect(await readdir(forgePaths(directory).failuresDir)).toHaveLength(1);
	});

	test("fake provider picks the response by verb, in sequence for arrays", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
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

	test("each createLlm starts a sequence at its first entry, and a second instance does not inherit the first one's cursor", async () => {
		const first = createLlm({ forgeDirectory: await tmpForge() });
		const second = createLlm({ forgeDirectory: await tmpForge() });
		const next = async (llm: ReturnType<typeof createLlm>) =>
			(
				await llm.generate({
					schema,
					prompt: "p",
					model: FAKE,
					verb: "sequence",
				})
			).object;
		// The cursor used to be module state keyed by file and verb, so the
		// second consumer in the same process inherited a position it never
		// set -- and which entry it got depended on the test order.
		expect(await next(first)).toEqual({ answer: 1 });
		expect(await next(first)).toEqual({ answer: 2 });
		expect(await next(second)).toEqual({ answer: 1 });
	});

	test("fake provider with a fenced response still fails loudly (generateObject does not strip fences)", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const failure = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "broken" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			"did not match the broken schema",
		);
		const rawPath = (failure as ForgeError).details.rawPath;
		expect(rawPath).toBeDefined();
		expect(await readFile(rawPath as string, "utf8")).toBe(
			'```json\n{"answer": 42}\n```',
		);
	});

	test("fake provider with an unknown verb throws ForgeError", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const failure = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "nope" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			'no entry for verb "nope"',
		);
		expect((failure as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
		expect((failure as ForgeError).details.rawPath).toBeUndefined();
	});

	test("fake provider names the file when the responses file has invalid JSON", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const malformed = "fake/tests/fixtures/fake-responses-malformed.txt";
		const failure = await llm
			.generate({ schema, prompt: "p", model: malformed, verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("invalid JSON");
		expect((failure as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses-malformed.txt",
		);
	});

	test("fake provider names the verb when a sequence entry is an empty array", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const failure = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "empty" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			'entry for "empty" is empty',
		);
		expect((failure as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
	});

	test("fake provider rejects an entry that is neither a string nor an array of strings", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const failure = await llm
			.generate({ schema, prompt: "p", model: FAKE, verb: "wrong_type" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain(
			'entry for "wrong_type" must be a string or an array of strings',
		);
		expect((failure as ForgeError).details.file).toBe(
			"tests/fixtures/fake-responses.json",
		);
	});

	test("fake provider names the file when the responses file is missing", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const missing = "fake/tests/fixtures/does-not-exist.json";
		const failure = await llm
			.generate({ schema, prompt: "p", model: missing, verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("does-not-exist.json");
		expect((failure as ForgeError).details.file).toBe(
			"tests/fixtures/does-not-exist.json",
		);
	});

	test("propagates errors other than NoObjectGeneratedError unwrapped", async () => {
		const directory = await tmpForge();
		const failingModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("network failure");
			},
		});
		const llm = createLlm({
			forgeDirectory: directory,
			resolve: () => failingModel,
		});
		const failure = await llm
			.generate({ schema, prompt: "p", model: "anthropic/x", verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).not.toBeInstanceOf(ForgeError);
		expect((failure as Error).message).toBe("network failure");
	});
});
