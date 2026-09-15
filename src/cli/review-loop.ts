import { parse, stringify } from "yaml";
import { ForgeError } from "../core/errors";
import {
	applyDecision,
	type Decision,
	type PendingItem,
	withExpected,
} from "../core/review";
import type {
	Case,
	Expected,
	Feature,
	Oracle,
	Scenario,
} from "../core/schemas";

export interface ReviewLoopArgs {
	items: PendingItem[];
	ask: (question: string, choices: string[]) => Promise<string>;
	openEditor: (yamlText: string) => Promise<string>;
	askExpected: (c: Case, oracle: Oracle) => Promise<Expected>;
	oracleOf: (scenarioId: string) => Oracle;
	print: (line: string) => void;
}

export interface ReviewLoopResult {
	decisions: {
		kind: PendingItem["kind"];
		id: string;
		item: Feature | Scenario | Case;
	}[];
	summary: {
		approved: number;
		rejected: number;
		edited: number;
		skipped: number;
	};
}

const CHOICES: Decision[] = ["approve", "reject", "edit", "skip"];

/**
 * Drives one interactive pass over `items`. Every side effect — prompting,
 * opening an editor, asking for an expected outcome, printing — arrives as
 * an injected function, so this function performs no I/O itself and is
 * fully exercised by scripting those functions in tests.
 *
 * A case with no `expected` is sent through `askExpected` before it can be
 * approved or edited. An invalid edit (one that fails the matching schema)
 * is reported and the same item is re-asked, rather than moving on. `skip`
 * produces no decision at all — the caller writes back only what is
 * decided, and a skipped item must not be rewritten.
 */
export async function runReviewLoop(
	args: ReviewLoopArgs,
): Promise<ReviewLoopResult> {
	const decisions: ReviewLoopResult["decisions"] = [];
	const summary = { approved: 0, rejected: 0, edited: 0, skipped: 0 };

	for (const pending of args.items) {
		let current: Feature | Scenario | Case = pending.item;
		for (;;) {
			args.print(`--- ${pending.kind} ${current.id} ---`);
			args.print(stringify(current, { lineWidth: 0 }).trimEnd());
			const answer = (await args.ask(
				`${pending.kind} ${current.id}:`,
				CHOICES,
			)) as Decision;

			try {
				if (
					pending.kind === "case" &&
					(answer === "approve" || answer === "edit") &&
					(current as Case).expected === undefined
				) {
					const oracle = args.oracleOf((current as Case).scenario);
					const expected = await args.askExpected(current as Case, oracle);
					current = withExpected(current as Case, expected);
				}

				if (answer === "edit") {
					const editedText = await args.openEditor(
						stringify(current, { lineWidth: 0 }),
					);
					current = applyDecision(current, "edit", parse(editedText));
					summary.edited += 1;
					decisions.push({ kind: pending.kind, id: current.id, item: current });
					break;
				}

				if (answer === "skip") {
					summary.skipped += 1;
					break;
				}

				current = applyDecision(current, answer);
				summary[answer === "approve" ? "approved" : "rejected"] += 1;
				decisions.push({ kind: pending.kind, id: current.id, item: current });
				break;
			} catch (e) {
				if (e instanceof ForgeError) {
					args.print(`cannot apply: ${e.message}`);
					continue;
				}
				throw e;
			}
		}
	}

	return { decisions, summary };
}
