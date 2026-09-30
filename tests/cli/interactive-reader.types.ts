/**
 * A type-level test, checked by `bun run typecheck` and never run: the
 * file name is not `*.test.ts`, so `bun test` does not load it.
 *
 * The review's questions must read through a reader whose interactive
 * pass has been started, because starting it is what arms "Ctrl+C ends
 * the input" (see `src/cli/interruptible-stdin.ts`). A plain line reader
 * handed to `askChoice` or `askExpectedFor` compiled before, and a Ctrl+C
 * during such a pass exited at once, losing every decision already taken.
 * Each `@ts-expect-error` below fails the typecheck ("Unused
 * '@ts-expect-error' directive") the day a plain function is accepted
 * again.
 */
import { askChoice, askExpectedFor } from "../../src/cli/prompts";
import type { Case } from "../../src/core/schemas";

const plainReader = async (): Promise<string> => "approve";
const printNothing = (_line: string): void => {};
const pendingCase: Case = {
	id: "s-01",
	scenario: "s",
	input: { email: "a" },
	status: "pending",
	generated_by: "t",
};

export function plainReadersAreRefused(): void {
	void askChoice(
		"q",
		["approve", "skip"],
		// @ts-expect-error a plain function is not an armed InteractiveReader
		{ stdin: plainReader, stdout: printNothing },
	);
	void askExpectedFor(
		pendingCase,
		"label",
		// @ts-expect-error a plain function is not an armed InteractiveReader
		{ stdin: plainReader, stdout: printNothing },
		() => null,
	);
}
