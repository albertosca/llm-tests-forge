import { loadTemplate } from "../../llm/templates";
import type { CliContext } from "../context";

/**
 * Prints the manual embedded in the binary: it needs no project and reads
 * no file, so it always matches the installed version.
 */
export async function guideCommand(
	_commandArguments: string[],
	context: CliContext,
): Promise<void> {
	context.stdout(loadTemplate("guide"));
}
