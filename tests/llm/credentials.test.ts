import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultConfigDirectory,
	loadProviderKeys,
	PROVIDER_KEY_FILES,
} from "../../src/llm/credentials";

/**
 * A config directory laid out like `~/.config`, in a temporary folder:
 * these tests never read the real key files.
 */
async function configDirectoryWith(
	files: Record<string, string>,
): Promise<string> {
	const configDirectory = await mkdtemp(join(tmpdir(), "forge-keys-"));
	for (const [provider, contents] of Object.entries(files)) {
		await mkdir(join(configDirectory, provider), { recursive: true });
		await writeFile(join(configDirectory, provider, "api.env"), contents);
	}
	return configDirectory;
}

describe("PROVIDER_KEY_FILES", () => {
	test("names the file each provider's key lives in", () => {
		expect(PROVIDER_KEY_FILES).toEqual({
			ANTHROPIC_API_KEY: "anthropic/api.env",
			GOOGLE_API_KEY: "google/api.env",
			OPENAI_API_KEY: "openai/api.env",
		});
	});
});

describe("defaultConfigDirectory", () => {
	test("is ~/.config", () => {
		expect(defaultConfigDirectory()).toBe(join(homedir(), ".config"));
	});
});

describe("loadProviderKeys", () => {
	test("fills a key missing from the environment from its provider's file, and says which", async () => {
		const configDirectory = await configDirectoryWith({
			anthropic: "ANTHROPIC_API_KEY=from-anthropic-file\n",
			google: "GOOGLE_API_KEY=from-google-file\n",
			openai: "OPENAI_API_KEY=from-openai-file\n",
		});
		const environment: Record<string, string | undefined> = {};
		const loaded = await loadProviderKeys({ environment, configDirectory });
		expect(environment).toEqual({
			ANTHROPIC_API_KEY: "from-anthropic-file",
			GOOGLE_API_KEY: "from-google-file",
			OPENAI_API_KEY: "from-openai-file",
		});
		expect(loaded).toEqual([
			"ANTHROPIC_API_KEY",
			"GOOGLE_API_KEY",
			"OPENAI_API_KEY",
		]);
	});

	test("a value already in the environment always wins over the file", async () => {
		const configDirectory = await configDirectoryWith({
			google: "GOOGLE_API_KEY=from-google-file\n",
		});
		const environment: Record<string, string | undefined> = {
			GOOGLE_API_KEY: "from-shell",
		};
		const loaded = await loadProviderKeys({ environment, configDirectory });
		expect(environment.GOOGLE_API_KEY).toBe("from-shell");
		expect(loaded).toEqual([]);
	});

	test("an empty value in the environment counts as missing, as requireKey treats it", async () => {
		const configDirectory = await configDirectoryWith({
			openai: "OPENAI_API_KEY=from-openai-file\n",
		});
		const environment: Record<string, string | undefined> = {
			OPENAI_API_KEY: "",
		};
		await loadProviderKeys({ environment, configDirectory });
		expect(environment.OPENAI_API_KEY).toBe("from-openai-file");
	});

	test("an absent file, an unreadable one, or one without the key leaves the variable unset and throws nothing", async () => {
		const configDirectory = await configDirectoryWith({
			// The key's name is not in this file: its other names are not loaded.
			google: "GEMINI_API=other-name\n",
			openai: "OPENAI_API_KEY=unreadable\n",
		});
		await chmod(join(configDirectory, "openai", "api.env"), 0o000);
		try {
			const environment: Record<string, string | undefined> = {};
			const loaded = await loadProviderKeys({ environment, configDirectory });
			expect(environment).toEqual({});
			expect(loaded).toEqual([]);
		} finally {
			await chmod(join(configDirectory, "openai", "api.env"), 0o600);
		}
	});

	test("reads NAME=value lines only: comments, blank lines and an export prefix are tolerated, and a value keeps any = it holds", async () => {
		const configDirectory = await configDirectoryWith({
			anthropic:
				"# comment\n\nexport ANTHROPIC_API_KEY=part-one=part-two\n  \nOTHER=x\n",
		});
		const environment: Record<string, string | undefined> = {};
		await loadProviderKeys({ environment, configDirectory });
		expect(environment).toEqual({ ANTHROPIC_API_KEY: "part-one=part-two" });
	});
});
