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
	const selection = selectCases({
		suite,
		scenarios: await readScenarios(ctx.forgeDir),
		casesByScenario: await readAllCases(ctx.forgeDir),
		paths,
	});
	if (selection.blockers.length > 0)
		throw new ForgeError(
			`emit refused: ${selection.blockers.length} item${selection.blockers.length === 1 ? " is" : "s are"} still pending; run \`forge review\`\n  ${selection.blockers.join("\n  ")}`,
		);
	if (selection.cases.length === 0)
		throw new ForgeError("no approved case to emit; run `forge review` first", {
			file: paths.casesDir,
		});
	if (format === "jsonl") {
		await writeFile(paths.casesJsonl, renderCasesJsonl({ selection }), "utf8");
		ctx.stdout(
			`emit: wrote ${paths.casesJsonl} (${selection.cases.length} cases)`,
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
		`emit: wrote ${paths.promptfooConfig} (${selection.cases.length} cases, ${selection.scenarios.length} scenarios, ${suite.target.models.length} target model${suite.target.models.length === 1 ? "" : "s"}, ${suite.judges.length} judge${suite.judges.length === 1 ? "" : "s"})`,
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
