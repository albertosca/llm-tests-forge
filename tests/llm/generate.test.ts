import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { ForgeError } from "../../src/core/errors";
import { forgePaths } from "../../src/core/files";
import { createLlm } from "../../src/llm/generate";
import { fixturePath } from "../helpers/repository";

const schema = z.object({ answer: z.number() });
const FAKE_FILE = fixturePath("fake-responses.json");
const FAKE = `fake/${FAKE_FILE}`;

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
		expect((failure as ForgeError).details.file).toBe(FAKE_FILE);
		expect((failure as ForgeError).details.rawPath).toBeUndefined();
	});

	test("fake provider names the file when the responses file has invalid JSON", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const malformedFile = fixturePath("fake-responses-malformed.txt");
		const malformed = `fake/${malformedFile}`;
		const failure = await llm
			.generate({ schema, prompt: "p", model: malformed, verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("invalid JSON");
		expect((failure as ForgeError).details.file).toBe(malformedFile);
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
		expect((failure as ForgeError).details.file).toBe(FAKE_FILE);
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
		expect((failure as ForgeError).details.file).toBe(FAKE_FILE);
	});

	test("fake provider names the file when the responses file is missing", async () => {
		const directory = await tmpForge();
		const llm = createLlm({ forgeDirectory: directory });
		const missingFile = fixturePath("does-not-exist.json");
		const missing = `fake/${missingFile}`;
		const failure = await llm
			.generate({ schema, prompt: "p", model: missing, verb: "probe" })
			.catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).message).toContain("does-not-exist.json");
		expect((failure as ForgeError).details.file).toBe(missingFile);
	});

	/** A responses file in a temporary folder, as `fake/<path>` names it. */
	async function fakeFileWith(responses: unknown): Promise<string> {
		const file = join(await mkdtemp(join(tmpdir(), "forge-fake-")), "r.json");
		await writeFile(file, JSON.stringify(responses));
		return file;
	}
	const generateOnce = (
		llm: ReturnType<typeof createLlm>,
		model: string,
		verb: string,
	) => llm.generate({ schema, prompt: "p", model, verb });

	test("a sequence entry keeps its own place per verb, and past its end repeats the last response", async () => {
		const file = await fakeFileWith({
			first: ['{"answer": 1}', '{"answer": 2}'],
			second: ['{"answer": 10}', '{"answer": 20}'],
		});
		const llm = createLlm({ forgeDirectory: await tmpForge() });
		const answers: number[] = [];
		for (const verb of ["first", "second", "first", "second", "first"])
			answers.push(
				(await generateOnce(llm, `fake/${file}`, verb)).object.answer,
			);
		expect(answers).toEqual([1, 10, 2, 20, 2]);
	});

	test("an array entry with something other than a string in it is refused, not read as text", async () => {
		const file = await fakeFileWith({ mixed: ['{"answer": 1}', 2] });
		const failure = await generateOnce(
			createLlm({ forgeDirectory: await tmpForge() }),
			`fake/${file}`,
			"mixed",
		).catch((thrown: unknown) => thrown);
		expect(failure).toBeInstanceOf(ForgeError);
		expect((failure as ForgeError).reason).toBe(
			'fake responses entry for "mixed" must be a string or an array of strings',
		);
	});

	test("a missing responses file is refused by name, with the file in the details", async () => {
		const missing = fixturePath("does-not-exist.json");
		const failure = await generateOnce(
			createLlm({ forgeDirectory: await tmpForge() }),
			`fake/${missing}`,
			"probe",
		).catch((thrown: unknown) => thrown);
		expect((failure as ForgeError).reason).toBe(
			"fake responses file not found",
		);
		expect((failure as ForgeError).details).toEqual({ file: missing });
	});

	describe("a model output that does not match the schema", () => {
		/** A schema whose check throws a ZodError of two issues, wrapped in `wrappers` plain errors (each the cause of the one above). */
		const failingSchema = (wrappers: number) =>
			z.object({ answer: z.number() }).transform((): { answer: number } => {
				let inner: unknown = new z.ZodError([
					{ code: "custom", path: ["answer"], message: "first problem" },
					{ code: "custom", path: ["deep", "path"], message: "second problem" },
				]);
				for (let level = 0; level < wrappers; level += 1)
					inner = new Error(`wrapper ${level}`, { cause: inner });
				throw inner;
			});
		const reasonWith = async (
			schemaToUse: z.ZodType<{ answer: number }>,
			model: ReturnType<typeof mock>,
		) => {
			const failure = await createLlm({
				forgeDirectory: await tmpForge(),
				resolve: () => model,
			})
				.generate({
					schema: schemaToUse,
					prompt: "p",
					model: "anthropic/x",
					verb: "probe",
				})
				.catch((thrown: unknown) => thrown);
			expect(failure).toBeInstanceOf(ForgeError);
			return (failure as ForgeError).reason;
		};

		test("says the schema's own reasons, each as `path: message`, joined by `; `", async () => {
			expect(await reasonWith(failingSchema(0), mock('{"answer": 1}'))).toBe(
				"model output did not match the probe schema: No object generated: response did not match schema. answer: first problem; deep.path: second problem",
			);
		});
		test("finds the reasons through the SDK's wrapping, but only a few levels down", async () => {
			const found = "answer: first problem; deep.path: second problem";
			expect(
				await reasonWith(failingSchema(2), mock('{"answer": 1}')),
			).toEndWith(`schema. ${found}`);
			// One level further down is beyond what is searched: the sentence
			// stands alone, with nothing appended.
			expect(await reasonWith(failingSchema(3), mock('{"answer": 1}'))).toBe(
				"model output did not match the probe schema: No object generated: response did not match schema.",
			);
		});
		test("without reasons the sentence ends at the SDK's own message", async () => {
			expect(await reasonWith(schema, mock("not json at all"))).toBe(
				"model output did not match the probe schema: No object generated: could not parse the response.",
			);
		});
		test("a response with no text at all still leaves an empty file to look at", async () => {
			const directory = await tmpForge();
			const silent = new MockLanguageModelV4({
				doGenerate: async () => ({
					content: [],
					finishReason: { unified: "stop", raw: undefined },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 0, text: 0, reasoning: 0 },
					},
					warnings: [],
				}),
			});
			const failure = await createLlm({
				forgeDirectory: directory,
				resolve: () => silent,
				now: () => new Date("2026-09-14T10:00:00Z"),
			})
				.generate({ schema, prompt: "p", model: "anthropic/x", verb: "probe" })
				.catch((thrown: unknown) => thrown);
			const rawPath = (failure as ForgeError).details.rawPath;
			expect(rawPath).toBe(
				join(
					forgePaths(directory).failuresDir,
					"probe-2026-09-14T10-00-00.000Z.txt",
				),
			);
			expect(await readFile(rawPath as string, "utf8")).toBe("");
		});
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

	test("beforeResolve runs before a real model is resolved, and never for a fake one", async () => {
		const calls: string[] = [];
		const llm = createLlm({
			forgeDirectory: await tmpForge(),
			beforeResolve: async () => {
				calls.push("keys");
			},
			resolve: () => {
				calls.push("resolve");
				return mock('{"answer": 1}');
			},
		});
		await llm.generate({ schema, prompt: "p", model: FAKE, verb: "probe" });
		expect(calls).toEqual([]);
		await llm.generate({
			schema,
			prompt: "p",
			model: "anthropic/x",
			verb: "probe",
		});
		expect(calls).toEqual(["keys", "resolve"]);
	});
});
