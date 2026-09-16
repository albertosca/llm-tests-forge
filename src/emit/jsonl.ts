import { ForgeError } from "../core/errors";
import type { Selection } from "../core/select";

/** The portable export: one case per line for any consumer that is not promptfoo. Same in-memory selection as the promptfoo emitter. */
export function renderCasesJsonl(args: { selection: Selection }): string {
	const kinds = new Map(args.selection.scenarios.map((s) => [s.id, s.kind]));
	const lines = args.selection.cases.map((c) => {
		const kind = kinds.get(c.scenario);
		if (!kind)
			throw new ForgeError(
				`case ${c.id} names scenario "${c.scenario}", which is not selected`,
				{ id: c.id },
			);
		return JSON.stringify({
			id: c.id,
			scenario: c.scenario,
			kind,
			input: c.input,
			expected: c.expected,
		});
	});
	return `${lines.join("\n")}\n`;
}
