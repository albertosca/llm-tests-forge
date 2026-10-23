import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeFeature } from "../../core/describe";
import { ForgeError } from "../../core/errors";
import {
	forgePaths,
	readFeatureIfPresent,
	writeFeature,
	writeSuite,
	writeText,
} from "../../core/files";
import {
	PROJECT_FILE,
	type Project,
	registerSuite,
	registrationHint,
} from "../../core/project";
import { DEFAULT_ENTRY } from "../../core/target";
import type { CliContext } from "../context";

/**
 * What the refusal adds for a suite missing from forge.yaml: a suite made
 * before init (or copied in) is reviewed but unregistered, and the refusal
 * is where registering it through describe dead-ends. A forge.yaml that
 * registering refuses gives its reason here, after the refusal, rather
 * than in place of it; the reason names forge.yaml by its path once, and
 * the refusal's own suffix names feature.yaml.
 */
function unregisteredNote(project: Project, suiteDirectory: string): string {
	try {
		const registration = registerSuite(project, suiteDirectory);
		return registration === null
			? ""
			: `. This suite is not registered in ${PROJECT_FILE}: to register it without describing it again, ${registrationHint(registration.entry)}`;
	} catch (error) {
		if (!(error instanceof ForgeError)) throw error;
		return `. This suite may not be registered in ${project.file}: ${error.reason}`;
	}
}

/**
 * `describe` is the one verb that replaces a whole file rather than
 * appending to it, and `feature.yaml`'s `invariants` are the rules the
 * person adds by hand — the highest-value human input in the pipeline.
 * Overwriting a feature that has been through review is therefore refused
 * by name, before a single token is spent, unless `--force` says that is
 * exactly what was wanted. A still-pending feature is nobody's reviewed
 * work, so re-describing over it stays free.
 */
async function refuseToOverwriteReviewedFeature(
	context: CliContext,
	force: boolean,
): Promise<void> {
	if (force) return;
	const existing = await readFeatureIfPresent(context.forgeDirectory);
	if (existing === undefined || existing.status === "pending") return;
	const unregistered =
		context.project === null
			? ""
			: unregisteredNote(context.project, dirname(context.forgeDirectory));
	throw new ForgeError(
		`feature "${existing.id}" is already ${existing.status}; describe would overwrite the reviewed description and its invariants — re-run with --force to replace it${unregistered}`,
		{ file: forgePaths(context.forgeDirectory).feature, id: existing.id },
	);
}

export async function describeCommand(
	commandArguments: string[],
	context: CliContext,
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: commandArguments,
		options: {
			"prompt-file": { type: "string" },
			drafter: { type: "string" },
			force: { type: "boolean" },
		},
		allowPositionals: true,
	});
	await refuseToOverwriteReviewedFeature(context, values.force === true);
	const text =
		positionals.length > 0 ? positionals.join(" ") : await context.stdin();
	const promptFile = values["prompt-file"];
	// The path is given from where the command runs; the feature keeps it
	// from the suite directory, which is where estimate and report read it.
	const promptPath = promptFile ? resolve(context.cwd, promptFile) : undefined;
	const promptText = promptPath
		? await readFile(promptPath, "utf8").catch(() => {
				throw new ForgeError("file not found", { file: promptPath });
			})
		: undefined;
	const feature = await describeFeature({
		text,
		promptText,
		model: values.drafter ?? context.drafter,
		llm: context.llm,
	});
	const withFile = promptPath
		? {
				...feature,
				// An absolute path stays as given; a relative one is rebased.
				// Stryker disable next-line StringLiteral: this branch runs only when promptPath is set, which needs a non-empty promptFile, so the fallback is never read (it is there for the type alone).
				prompt_file: isAbsolute(promptFile ?? "")
					? promptPath
					: relative(dirname(context.forgeDirectory), promptPath),
			}
		: feature;
	await writeFeature(context.forgeDirectory, withFile);
	context.stdout(
		`describe: feature "${withFile.id}" written as pending -> ${forgePaths(context.forgeDirectory).feature}; run \`llm-tests-forge review\` to approve it`,
	);
	await registerInProject(context);
}

/**
 * Adds this suite to forge.yaml, and writes a starting suite.yaml when the
 * defaults allow one. Outside a project there is nothing to do.
 */
async function registerInProject(context: CliContext): Promise<void> {
	const project = context.project;
	if (project === null) return;
	const registration = registerSuite(project, dirname(context.forgeDirectory));
	if (registration !== null) {
		await writeText(project.file, registration.text);
		context.stdout(
			`describe: registered ${registration.entry} in ${project.file}`,
		);
	}
	const { language, defaults } = project.config;
	const suitePath = forgePaths(context.forgeDirectory).suite;
	const present = await access(suitePath).then(
		() => true,
		// Stryker disable next-line ArrowFunction: `present` is only read in `present || language === "other"`, where undefined is false too.
		() => false,
	);
	if (present || language === "other") return;
	if (defaults.target_models === undefined || defaults.judges === undefined)
		return;
	await writeSuite(context.forgeDirectory, {
		target: {
			kind: language,
			entry: DEFAULT_ENTRY[language],
			models: defaults.target_models,
		},
		judges: defaults.judges,
		repeat: 1,
		include: [],
	});
	context.stdout(
		`describe: wrote ${suitePath} from forge.yaml's defaults; check it before emit`,
	);
}
