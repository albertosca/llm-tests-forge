import { z } from "zod";
import { ForgeError } from "../../src/core/errors";
import type { GenerateArgs, Llm } from "../../src/llm/generate";
import { parseModelSpec } from "../../src/llm/models";

export interface ClaudeCliOptions {
	/** The Claude Code executable; a stand-alone path in tests. */
	command?: string;
	environment?: Record<string, string | undefined>;
}

const SYSTEM_PROMPT =
	"You are the model under test. Answer with exactly one JSON object that matches the JSON Schema given at the end of the prompt, and nothing else: no prose, no code fence.";

const CliReplySchema = z.object({
	result: z.string(),
	is_error: z.boolean().optional(),
	usage: z
		.object({
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
		})
		.optional(),
});

/**
 * The JSON object in a reply that may be wrapped in a code fence or a
 * sentence, braces in the prose included: the widest span that parses wins.
 */
function jsonObjectIn(text: string): unknown {
	if (!text.includes("{"))
		throw new ForgeError("the model's reply holds no JSON object");
	for (
		let first = text.indexOf("{");
		first !== -1;
		first = text.indexOf("{", first + 1)
	)
		for (
			let last = text.lastIndexOf("}");
			last > first;
			last = text.lastIndexOf("}", last - 1)
		)
			try {
				const parsed: unknown = JSON.parse(text.slice(first, last + 1));
				if (typeof parsed === "object" && parsed !== null) return parsed;
			} catch {
				// a shorter or later span may still be the object
			}
	throw new ForgeError("the model's reply holds no valid JSON object");
}

async function runClaude(
	command: string,
	environment: Record<string, string | undefined>,
	model: string,
	prompt: string,
): Promise<string> {
	// An exported API key would make claude bill the API, not the subscription.
	const {
		ANTHROPIC_API_KEY: _apiKey,
		ANTHROPIC_AUTH_TOKEN: _authToken,
		...subscriptionEnvironment
	} = environment;
	const child = Bun.spawn(
		[
			command,
			"-p",
			"--model",
			model,
			"--system-prompt",
			SYSTEM_PROMPT,
			"--setting-sources",
			"",
			"--disable-slash-commands",
			"--strict-mcp-config",
			"--tools",
			"",
			"--no-session-persistence",
			"--output-format",
			"json",
		],
		{
			stdin: new Response(prompt),
			stdout: "pipe",
			stderr: "pipe",
			env: subscriptionEnvironment,
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0)
		throw new ForgeError(
			`claude exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
		);
	return stdout;
}

/**
 * A model client that reaches Claude through the Claude Code CLI, so a run
 * is paid from the subscription's quota instead of API credit. The model is
 * the same one the spec names (`anthropic/claude-haiku-4-5` runs
 * `claude-haiku-4-5`); only the transport changes. The schema travels in the
 * prompt, since the CLI offers no structured-output switch.
 */
export function createClaudeCliLlm(options: ClaudeCliOptions = {}): Llm {
	const command = options.command ?? "claude";
	const environment = options.environment ?? process.env;
	return {
		async generate<T>(request: GenerateArgs<T>) {
			const { provider, model } = parseModelSpec(request.model);
			if (provider !== "anthropic")
				throw new ForgeError(
					`the claude-cli transport serves only anthropic/ models, got "${request.model}"`,
				);
			const prompt = `${request.prompt}\n\nAnswer with one JSON object matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(request.schema))}`;
			const stdout = await runClaude(command, environment, model, prompt);
			let reply: z.infer<typeof CliReplySchema>;
			try {
				reply = CliReplySchema.parse(JSON.parse(stdout));
			} catch {
				throw new ForgeError(
					"claude printed a reply that is not the JSON envelope",
				);
			}
			if (reply.is_error === true)
				throw new ForgeError(`claude: ${reply.result}`);
			const parsed = request.schema.safeParse(jsonObjectIn(reply.result));
			if (!parsed.success)
				throw new ForgeError(
					`model output did not match the ${request.verb} schema: ${parsed.error.issues
						.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
						.join("; ")}`,
				);
			return {
				object: parsed.data,
				usage: {
					inputTokens: reply.usage?.input_tokens ?? 0,
					outputTokens: reply.usage?.output_tokens ?? 0,
				},
			};
		},
	};
}
