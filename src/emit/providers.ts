import { ForgeError } from "../core/errors";

const PREFIX: Record<string, string> = {
	anthropic: "anthropic:messages:",
	google: "google:",
	openai: "openai:chat:",
	ollama: "ollama:chat:",
};

/** `provider/model` as the forge writes it → the id promptfoo 0.123 resolves. */
export function toPromptfooProvider(model: string): string {
	const slash = model.indexOf("/");
	const provider = slash < 0 ? "" : model.slice(0, slash);
	const prefix = PREFIX[provider];
	if (prefix === undefined || slash < 0)
		throw new ForgeError(
			`cannot emit a promptfoo provider for "${model}"; known: ${Object.keys(PREFIX).join(", ")}`,
			{ id: model },
		);
	return `${prefix}${model.slice(slash + 1)}`;
}

/** The inverse, for reading `results.json` back; `undefined` when the id is not one this forge wrote. */
export function fromPromptfooProvider(id: string): string | undefined {
	for (const [provider, prefix] of Object.entries(PREFIX)) {
		if (id.startsWith(prefix)) return `${provider}/${id.slice(prefix.length)}`;
	}
	return undefined;
}
