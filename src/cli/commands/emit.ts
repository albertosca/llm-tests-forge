import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { entryFor, isShimKind, type ShimKind } from "../../core/target";
import { plural } from "../../core/text";
import { renderCasesJsonl } from "../../emit/jsonl";
import {
	buildPromptfooConfig,
	renderPromptfooConfig,
} from "../../emit/promptfoo";
import { shimFiles, shimLocations, targetCommand } from "../../emit/shim";
import type { CliContext } from "../context";
import { requireApprovedFeature } from "../gates";

const FORMATS = ["promptfoo", "jsonl"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(raw: string | undefined): Format {
	if (raw === undefined) return "promptfoo";
	const found = FORMATS.find((format) => format === raw);
	if (!found)
		throw new UsageError(
			`--format "${raw}" is not valid; choose one of: ${FORMATS.join(", ")}`,
		);
	return found;
}

/** What the person does next, per kind; rust and go also build once. */
const FILL_IN: Record<ShimKind, string> = {
	python: "edit run_application() to call your application",
	javascript: "edit runApplication() to call your application",
	typescript: "edit runApplication() to call your application",
	elixir: "edit run_application/2 to call your application",
	ruby: "edit run_application to call your application",
	rust: "edit run_application in src/main.rs to call your application, then run `cargo build --release` in that directory",
	go: "edit runApplication in main.go to call your application, then run `go build -o forge_target .` in that directory",
};

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

export async function emitCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values } = parseArgs({
		args: commandArguments,
		options: { format: { type: "string" } },
	});
	const format = parseFormat(values.format);
	const paths = forgePaths(context.forgeDir);
	const feature = await readFeature(context.forgeDir);
	requireApprovedFeature(feature, paths.feature);
	const suite = await readSuite(context.forgeDir);
	// The shim is written into, and run from, `.forge/`; a path here would
	// let suite.yaml write a file anywhere on the disk.
	const entry = entryFor(suite.target);
	const shimKind = isShimKind(suite.target.kind) ? suite.target.kind : null;
	if (shimKind !== null) {
		if (entry.includes("/") || entry.includes("\\") || entry.includes(".."))
			throw new ForgeError(
				"target.entry must be a file name inside .forge, not a path",
				{ file: paths.suite },
			);
	}
	const selection = selectCases({
		suite,
		scenarios: await readScenarios(context.forgeDir),
		casesByScenario: await readAllCases(context.forgeDir),
		paths,
		feature,
	});
	if (selection.blockers.length > 0) {
		const count = selection.blockers.length;
		// A rejected item is not something `llm-tests-forge review` can give back, so
		// the hint is printed only when at least one blocker is reviewable.
		const hint =
			selection.reviewable > 0 ? "; run `llm-tests-forge review`" : "";
		throw new ForgeError(
			`emit refused: ${count} item${count === 1 ? " blocks" : "s block"} it${hint}\n  ${selection.blockers.join("\n  ")}`,
		);
	}
	if (selection.cases.length === 0)
		throw new ForgeError(
			"no approved case to emit; run `llm-tests-forge review` first",
			{
				file: paths.casesDir,
			},
		);
	if (format === "jsonl") {
		await writeFile(paths.casesJsonl, renderCasesJsonl({ selection }), "utf8");
		context.stdout(
			`emit: wrote ${paths.casesJsonl} (${plural(selection.cases.length, "case")})`,
		);
		return;
	}
	// The command comes before anything is written: an elixir suite with no
	// mix.exs above it is refused with no half-written .forge/.
	const locations =
		shimKind === null ? null : await shimLocations(shimKind, context.forgeDir);
	const command =
		shimKind === null || locations === null
			? undefined
			: targetCommand(shimKind, entry, locations);
	const config = buildPromptfooConfig({
		feature,
		suite,
		selection,
		featureFile: paths.feature,
		command,
	});
	await writeFile(paths.promptfooConfig, renderPromptfooConfig(config), "utf8");
	context.stdout(
		`emit: wrote ${paths.promptfooConfig} (${plural(selection.cases.length, "case")}, ${plural(selection.scenarios.length, "scenario")}, ${plural(suite.target.models.length, "target model")}, ${plural(suite.judges.length, "judge")})`,
	);
	if (shimKind === null || locations === null) return;
	const shim = join(context.forgeDir, entry);
	if (await exists(shim)) {
		context.stdout(`emit: kept existing ${shim}`);
		return;
	}
	for (const file of shimFiles(feature, shimKind, entry, locations)) {
		const path = join(context.forgeDir, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.content, "utf8");
	}
	context.stdout(`emit: wrote ${shim}; ${FILL_IN[shimKind]}`);
}
