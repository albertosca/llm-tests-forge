import { ForgeError } from "./errors";
import { nextCaseId } from "./ids";
import type { Case, Feature, Oracle, Scenario } from "./schemas";

export const IMPORTED_SCENARIO_ID = "imported";

export interface ImportArgs {
	feature: Feature;
	jsonl: string;
	source: string;
	existing: Case[];
	oracle?: Oracle;
}

export interface ImportResult {
	cases: Case[];
	scenario: Scenario;
	skipped: { line: number; reason: string }[];
}

function deriveOracle(feature: Feature): Oracle {
	switch (feature.output?.kind) {
		case "label":
			return "label";
		case "json":
			return "fields";
		default:
			return "rubric";
	}
}

function sameInput(
	a: Record<string, string>,
	b: Record<string, string>,
): boolean {
	const ka = Object.keys(a).sort();
	const kb = Object.keys(b).sort();
	return (
		ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
	);
}

export function importCases(args: ImportArgs): ImportResult {
	const inputNames = (args.feature.inputs ?? []).map((i) => i.name);
	const accepted: Case[] = [...args.existing];
	const skipped: { line: number; reason: string }[] = [];
	const lines = args.jsonl.split("\n");
	lines.forEach((raw, index) => {
		const line = index + 1;
		if (raw.trim() === "") return;
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			skipped.push({ line, reason: "not valid JSON" });
			return;
		}
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			skipped.push({ line, reason: "not a JSON object" });
			return;
		}
		const obj = data as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		if (
			keys.length !== inputNames.length ||
			!keys.every((k) => inputNames.includes(k))
		) {
			skipped.push({
				line,
				reason: `keys [${keys.join(", ")}] do not match feature inputs [${inputNames.join(", ")}]`,
			});
			return;
		}
		if (!Object.values(obj).every((v) => typeof v === "string")) {
			skipped.push({ line, reason: "every input value must be a string" });
			return;
		}
		const input = obj as Record<string, string>;
		if (accepted.some((c) => sameInput(c.input, input))) {
			skipped.push({ line, reason: "exact duplicate of an existing input" });
			return;
		}
		accepted.push({
			id: nextCaseId(IMPORTED_SCENARIO_ID, accepted),
			scenario: IMPORTED_SCENARIO_ID,
			input,
			status: "pending",
			generated_by: `import:${args.source}`,
		});
	});
	if (accepted.length === args.existing.length) {
		throw new ForgeError(
			`no line imported (${skipped.map((s) => `line ${s.line}: ${s.reason}`).join("; ") || "file is empty"})`,
			{ file: args.source },
		);
	}
	return {
		cases: accepted,
		scenario: {
			id: IMPORTED_SCENARIO_ID,
			kind: "happy",
			oracle: args.oracle ?? deriveOracle(args.feature),
			description: "Real inputs imported from application logs",
			status: "approved",
		},
		skipped,
	};
}
