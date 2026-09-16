import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateObject, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ZodType } from "zod";
import { ForgeError } from "../core/errors";
import { forgePaths } from "../core/files";
import { parseModelSpec, type ResolvedModel, resolveModel } from "./models";

export interface Usage {
	inputTokens: number;
	outputTokens: number;
}

export interface GenerateArgs<T> {
	schema: ZodType<T>;
	prompt: string;
	model: string;
	verb: string;
}

export interface Llm {
	generate<T>(args: GenerateArgs<T>): Promise<{ object: T; usage: Usage }>;
}

export interface CreateLlmOptions {
	forgeDir: string;
	resolve?: (spec: string) => ResolvedModel;
	now?: () => Date;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * `cursors` is where this fake is in each `<file>::<verb>` sequence. It
 * belongs to one `Llm` instance, passed in rather than held here: as
 * module state it lived for the whole process, so a second consumer — a
 * second `createContext`, a test running after another — inherited a
 * position it never set and got an entry it did not ask for.
 */
async function fakeModel(
	path: string,
	verb: string,
	cursors: Map<string, number>,
): Promise<ResolvedModel> {
	const text = await readFile(path, "utf8").catch(() => {
		throw new ForgeError("fake responses file not found", { file: path });
	});
	let responses: Record<string, unknown>;
	try {
		responses = JSON.parse(text) as Record<string, unknown>;
	} catch (e) {
		throw new ForgeError(`invalid JSON: ${(e as Error).message}`, {
			file: path,
		});
	}
	const entry = responses[verb];
	if (entry === undefined)
		throw new ForgeError(
			`fake responses file has no entry for verb "${verb}"`,
			{ file: path },
		);
	if (typeof entry !== "string" && !isStringArray(entry))
		throw new ForgeError(
			`fake responses entry for "${verb}" must be a string or an array of strings`,
			{ file: path },
		);
	let reply: string;
	if (Array.isArray(entry)) {
		const key = `${path}::${verb}`;
		const i = cursors.get(key) ?? 0;
		const picked = entry[Math.min(i, entry.length - 1)];
		if (picked === undefined)
			throw new ForgeError(`fake responses entry for "${verb}" is empty`, {
				file: path,
			});
		reply = picked;
		cursors.set(key, i + 1);
	} else {
		reply = entry;
	}
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text: reply }],
			finishReason: { unified: "stop", raw: undefined },
			usage: {
				inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 0, text: 0, reasoning: 0 },
			},
			warnings: [],
		}),
	});
}

export function createLlm(opts: CreateLlmOptions): Llm {
	const paths = forgePaths(opts.forgeDir);
	const now = opts.now ?? (() => new Date());
	const resolve = opts.resolve ?? resolveModel;
	/** This instance's position in each fake response sequence. */
	const fakeCursors = new Map<string, number>();

	async function pickModel(spec: string, verb: string): Promise<ResolvedModel> {
		const { provider, model } = parseModelSpec(spec);
		return provider === "fake"
			? fakeModel(model, verb, fakeCursors)
			: resolve(spec);
	}

	return {
		async generate<T>(args: GenerateArgs<T>) {
			const model = await pickModel(args.model, args.verb);
			const ts = now().toISOString();
			try {
				const result = await generateObject({
					model,
					schema: args.schema,
					prompt: args.prompt,
				});
				const usage: Usage = {
					inputTokens: result.usage.inputTokens ?? 0,
					outputTokens: result.usage.outputTokens ?? 0,
				};
				await mkdir(paths.root, { recursive: true });
				await appendFile(
					paths.usage,
					`${JSON.stringify({ ts, verb: args.verb, model: args.model, ...usage })}\n`,
				);
				return { object: result.object, usage };
			} catch (e) {
				if (NoObjectGeneratedError.isInstance(e)) {
					await mkdir(paths.failuresDir, { recursive: true });
					const rawPath = join(
						paths.failuresDir,
						`${args.verb}-${ts.replace(/:/g, "-")}.txt`,
					);
					await writeFile(rawPath, e.text ?? "", "utf8");
					throw new ForgeError(
						`model output did not match the ${args.verb} schema: ${e.message}`,
						{ rawPath },
					);
				}
				throw e;
			}
		},
	};
}
