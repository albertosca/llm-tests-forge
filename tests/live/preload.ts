/**
 * Preloaded by `bunfig.live.toml`, before any live test runs: the one place
 * the live suite reads provider keys the shell does not export, from
 * ~/.config/<provider>/api.env. A key already in the environment wins.
 */
import {
	defaultConfigDirectory,
	loadProviderKeys,
} from "../../src/llm/credentials";

await loadProviderKeys({
	environment: process.env,
	configDirectory: defaultConfigDirectory(),
});
