import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where each provider's key lives, relative to the config directory
 * (`~/.config`): one `api.env` per provider, a `0600` file of `NAME=value`
 * lines. The shell stops exporting these keys, so a forge started from a
 * new shell finds them here instead.
 */
export const PROVIDER_KEY_FILES: Record<string, string> = {
	ANTHROPIC_API_KEY: "anthropic/api.env",
	GOOGLE_API_KEY: "google/api.env",
	OPENAI_API_KEY: "openai/api.env",
};

/** `~/.config`, where the provider files live. */
export function defaultConfigDirectory(): string {
	return join(homedir(), ".config");
}

/** The value `name` has in an `api.env` text, or `undefined`. */
function valueIn(text: string, name: string): string | undefined {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim().replace(/^export\s+/, "");
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator > 0 && line.slice(0, separator) === name)
			return line.slice(separator + 1);
	}
	return undefined;
}

/**
 * Fills each provider key the environment does not already hold (or holds
 * empty, which `requireKey` treats as missing) from its provider's file.
 * A value already in the environment always wins. An absent or unreadable
 * file, or one without the key, leaves the variable unset: `requireKey`
 * still fails loudly, naming it, when a verb needs it. Returns the names
 * it filled, never their values.
 */
export async function loadProviderKeys(args: {
	environment: Record<string, string | undefined>;
	configDirectory: string;
}): Promise<string[]> {
	const { environment, configDirectory } = args;
	const loaded: string[] = [];
	for (const [name, file] of Object.entries(PROVIDER_KEY_FILES)) {
		if (environment[name]) continue;
		const text = await readFile(join(configDirectory, file), "utf8").catch(
			() => undefined,
		);
		const found = text === undefined ? undefined : valueIn(text, name);
		if (!found) continue;
		environment[name] = found;
		loaded.push(name);
	}
	return loaded;
}
