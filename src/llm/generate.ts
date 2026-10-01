import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateObject, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ZodError, type ZodType } from "zod";
import { ForgeError, messageOf } from "../core/errors";
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

/**
 * The schema's own reasons behind a NoObjectGeneratedError, as
 * `path: message` joined by "; ", or "" when there are none. The AI SDK
 * wraps them two levels down (its TypeValidationError, then the ZodError),
 * and its own message says only "response did not match schema".
 */
function schemaReasons(error: unknown): string {
	let current: unknown = error;
	for (let depth = 0; depth < 4; depth += 1) {
		if (current instanceof ZodError)
			return current.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ");
		current =
			typeof current === "object" && current !== null && "cause" in current
				? current.cause
				: undefined;
	}
	return "";
}

export interface Llm {
	generate<T>(request: GenerateArgs<T>): Promise<{ object: T; usage: Usage }>;
}

export interface CreateLlmOptions {
	forgeDirectory: string;
	resolve?: (spec: string) => ResolvedModel;
	/**
	 * Runs before a real (not `fake/`) model is resolved: the CLI reads the
	 * provider keys here, so a verb that never reaches a model, and a
	 * command line refused for its usage, opens no key file.
	 */
	beforeResolve?: () => Promise<void>;
	now?: () => Date;
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
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
	} catch (error) {
		throw new ForgeError(`invalid JSON: ${messageOf(error)}`, {
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
		const position = cursors.get(key) ?? 0;
		const picked = entry[Math.min(position, entry.length - 1)];
		if (picked === undefined)
			throw new ForgeError(`fake responses entry for "${verb}" is empty`, {
				file: path,
			});
		reply = picked;
		cursors.set(key, position + 1);
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

export function createLlm(options: CreateLlmOptions): Llm {
	const paths = forgePaths(options.forgeDirectory);
	const now = options.now ?? (() => new Date());
	const resolve = options.resolve ?? resolveModel;
	/** This instance's position in each fake response sequence. */
	const fakeCursors = new Map<string, number>();

	async function pickModel(spec: string, verb: string): Promise<ResolvedModel> {
		const { provider, model } = parseModelSpec(spec);
		if (provider === "fake") return fakeModel(model, verb, fakeCursors);
		await options.beforeResolve?.();
		return resolve(spec);
	}

	return {
		async generate<T>(request: GenerateArgs<T>) {
			const model = await pickModel(request.model, request.verb);
			const timestamp = now().toISOString();
			try {
				const result = await generateObject({
					model,
					schema: request.schema,
					prompt: request.prompt,
				});
				const usage: Usage = {
					inputTokens: result.usage.inputTokens ?? 0,
					outputTokens: result.usage.outputTokens ?? 0,
				};
				await mkdir(paths.root, { recursive: true });
				await appendFile(
					paths.usage,
					`${JSON.stringify({ ts: timestamp, verb: request.verb, model: request.model, ...usage })}\n`,
				);
				return { object: result.object, usage };
			} catch (error) {
				if (NoObjectGeneratedError.isInstance(error)) {
					await mkdir(paths.failuresDir, { recursive: true });
					const rawPath = join(
						paths.failuresDir,
						`${request.verb}-${timestamp.replace(/:/g, "-")}.txt`,
					);
					await writeFile(rawPath, error.text ?? "", "utf8");
					const reasons = schemaReasons(error.cause);
					throw new ForgeError(
						`model output did not match the ${request.verb} schema: ${error.message}${reasons === "" ? "" : ` ${reasons}`}`,
						{ rawPath },
					);
				}
				throw error;
			}
		},
	};
}
