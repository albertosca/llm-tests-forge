import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ForgeError, UsageError } from "../../core/errors";
import {
	forgePaths,
	readAllCases,
	readFeature,
	readScenarios,
	readSuite,
} from "../../core/files";
import { selectCases } from "../../core/select";
import { plural } from "../../core/text";
import { renderCasesJsonl } from "../../emit/jsonl";
import {
	buildPromptfooConfig,
	renderPromptfooConfig,
} from "../../emit/promptfoo";
import { shimSource } from "../../emit/shim";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";

const FORMATS = ["promptfoo", "jsonl"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(raw: string | undefined): Format {
	if (raw === undefined) return "promptfoo";
	const found = FORMATS.find((f) => f === raw);
	if (!found)
		throw new UsageError(
			`--format "${raw}" is not valid; choose one of: ${FORMATS.join(", ")}`,
		);
	return found;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

export async function emitCommand(
	args: string[],
	ctx: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args,
		options: { format: { type: "string" } },
	});
	const format = parseFormat(values.format);
	const paths = forgePaths(ctx.forgeDir);
	const feature = await readFeature(ctx.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	const suite = await readSuite(ctx.forgeDir);
	// The shim is written into, and run from, `.forge/`; a path here would
	// let suite.yaml write a file anywhere on the disk.
	const entry = suite.target.entry;
	if (entry.includes("/") || entry.includes("\\") || entry.includes(".."))
		throw new ForgeError(
			"target.entry must be a file name inside .forge, not a path",
			{ file: paths.suite },
		);
	const selection = selectCases({
		suite,
		scenarios: await readScenarios(ctx.forgeDir),
		casesByScenario: await readAllCases(ctx.forgeDir),
		paths,
		feature,
	});
	if (selection.blockers.length > 0) {
		const n = selection.blockers.length;
		// A rejected item is not something `forge review` can give back, so
		// the hint is printed only when at least one blocker is reviewable.
		const hint = selection.reviewable > 0 ? "; run `forge review`" : "";
		throw new ForgeError(
			`emit refused: ${n} item${n === 1 ? " blocks" : "s block"} it${hint}\n  ${selection.blockers.join("\n  ")}`,
		);
	}
	if (selection.cases.length === 0)
		throw new ForgeError("no approved case to emit; run `forge review` first", {
			file: paths.casesDir,
		});
	if (format === "jsonl") {
		await writeFile(paths.casesJsonl, renderCasesJsonl({ selection }), "utf8");
		ctx.stdout(
			`emit: wrote ${paths.casesJsonl} (${plural(selection.cases.length, "case")})`,
		);
		return;
	}
	const config = buildPromptfooConfig({
		feature,
		suite,
		selection,
		featureFile: paths.feature,
	});
	await writeFile(paths.promptfooConfig, renderPromptfooConfig(config), "utf8");
	ctx.stdout(
		`emit: wrote ${paths.promptfooConfig} (${plural(selection.cases.length, "case")}, ${plural(selection.scenarios.length, "scenario")}, ${plural(suite.target.models.length, "target model")}, ${plural(suite.judges.length, "judge")})`,
	);
	const shim = join(ctx.forgeDir, suite.target.entry);
	if (await exists(shim)) {
		ctx.stdout(`emit: kept existing ${shim}`);
	} else {
		await writeFile(shim, await shimSource(feature), "utf8");
		ctx.stdout(
			`emit: wrote ${shim}; edit run_application() to call your application`,
		);
	}
}
