import { ForgeError } from "../../src/core/errors";

/** What promptfoo's exec provider hands the program: the model and the case's inputs. */
export interface ExecInvocation {
	model: string;
	variables: Record<string, string>;
}

function parseObject(text: string, name: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ForgeError(`the ${name} argument is not JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new ForgeError(`the ${name} argument is not a JSON object`);
	return parsed as Record<string, unknown>;
}

/** The three arguments of an exec target: the rendered prompt (unused here), the options JSON and the context JSON. */
export function parseExecArguments(argumentList: string[]): ExecInvocation {
	const [, optionsText, contextText] = argumentList;
	if (optionsText === undefined || contextText === undefined)
		throw new ForgeError(
			"an exec target takes three arguments: the prompt, the options JSON and the context JSON",
		);
	const config = parseObject(optionsText, "options").config;
	const model =
		typeof config === "object" && config !== null && "model" in config
			? config.model
			: undefined;
	if (typeof model !== "string" || model === "")
		throw new ForgeError("the options JSON has no config.model");
	const rawVariables = parseObject(contextText, "context").vars;
	const variables: Record<string, string> = {};
	if (typeof rawVariables === "object" && rawVariables !== null)
		for (const [name, value] of Object.entries(rawVariables)) {
			if (name.startsWith("__")) continue;
			if (typeof value !== "string")
				throw new ForgeError(
					`the \`${name}\` input must be text, got ${value === null ? "null" : typeof value}`,
				);
			variables[name] = value;
		}
	return { model, variables };
}
