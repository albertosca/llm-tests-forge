import { access } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { planAgentsBlock } from "../../core/agents-block";
import { UsageError } from "../../core/errors";
import { readText, writeText } from "../../core/files";
import { detectLanguage } from "../../core/language";
import {
	findProjectRoot,
	PROJECT_FILE,
	projectFileText,
} from "../../core/project";
import { LANGUAGES, type Language } from "../../core/schemas";
import type { CliContext } from "../context";

const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";

async function readIfPresent(path: string): Promise<string | null> {
	const present = await access(path).then(
		() => true,
		() => false,
	);
	return present ? readText(path) : null;
}

function parseLanguage(value: string): Language {
	const found = LANGUAGES.find((language) => language === value);
	if (found === undefined)
		throw new UsageError(
			`--language "${value}" is not valid; expected one of: ${LANGUAGES.join(", ")}`,
		);
	return found;
}

/** What `init` says about the forge.yaml it is about to write. */
async function chooseLanguage(
	root: string,
	override: Language | undefined,
): Promise<{ language: Language; origin: string }> {
	if (override !== undefined)
		return { language: override, origin: "from --language" };
	const detected = await detectLanguage(root);
	if (detected === null)
		return {
			language: "other",
			origin: "no manifest found; pass --language or edit forge.yaml",
		};
	return {
		language: detected.language,
		origin: `from ${detected.manifest}`,
	};
}

/**
 * `init` works at the nearest project root above the current directory, or
 * at the current directory when there is none. It reads no forge.yaml: an
 * existing one is left as it is (so a broken one cannot stop the AGENTS.md
 * block), and `main()` does not resolve the project for this verb.
 */
export async function initCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
		options: { language: { type: "string" } },
	});
	const override =
		values.language === undefined ? undefined : parseLanguage(values.language);
	const root = (await findProjectRoot(context.cwd)) ?? context.cwd;
	const projectPath = join(root, PROJECT_FILE);
	const agentsPath = join(root, AGENTS_FILE);

	// Everything that can refuse is computed before anything is written.
	const existingProject = await readIfPresent(projectPath);
	const existingAgents = await readIfPresent(agentsPath);
	const planned = planAgentsBlock(AGENTS_FILE, existingAgents);
	const chosen =
		existingProject === null ? await chooseLanguage(root, override) : null;

	// AGENTS.md first: if it cannot be written, no forge.yaml is left behind
	// and a rerun starts clean.
	await writeText(agentsPath, planned.text);
	if (chosen !== null)
		await writeText(projectPath, projectFileText(chosen.language));

	if (chosen === null) {
		context.stdout(
			override === undefined
				? `init: ${PROJECT_FILE} exists, left untouched`
				: `init: ${PROJECT_FILE} exists, left untouched; --language ${override} ignored`,
		);
	} else {
		context.stdout(
			`init: wrote ${PROJECT_FILE} (language: ${chosen.language}, ${chosen.origin})`,
		);
	}
	context.stdout(
		`init: ${planned.replaced ? "updated" : "wrote"} the llm-tests-forge block in ${AGENTS_FILE}`,
	);

	const claude = await readIfPresent(join(root, CLAUDE_FILE));
	if (claude !== null && !claude.includes(AGENTS_FILE))
		context.stdout(
			`init: ${CLAUDE_FILE} does not import ${AGENTS_FILE}; add the line "@${AGENTS_FILE}" to it so Claude Code reads the block`,
		);
}
