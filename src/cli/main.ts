import { access } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError, UsageError } from "../core/errors";
import { readSuiteIfPresent, stampSuite } from "../core/files";
import { registeredSuiteNames } from "../core/project";
import { resolveSuite } from "../core/resolve";
import { FORGE_VERSION, versionWarning } from "../core/version";
import { loadProviderKeys } from "../llm/credentials";
import { casesCommand } from "./commands/cases";
import { dedupeCommand } from "./commands/dedupe";
import { describeCommand } from "./commands/describe";
import { emitCommand } from "./commands/emit";
import { estimateCommand } from "./commands/estimate";
import { guideCommand } from "./commands/guide";
import { importCommand } from "./commands/import";
import { initCommand } from "./commands/init";
import { moveCommand } from "./commands/move";
import { reportCommand } from "./commands/report";
import { reviewCommand } from "./commands/review";
import { scenariosCommand } from "./commands/scenarios";
import { statusCommand } from "./commands/status";
import { type CliContext, createContext } from "./context";
import type { InteractivePass } from "./interruptible-stdin";

export const USAGE = `usage: llm-tests-forge <verb> [options]
  init [--language l]                                 detect the language -> forge.yaml + the llm-tests-forge block in AGENTS.md
  describe <text...> [--prompt-file f] [--force] [--drafter m]
                                                     free text (or stdin) -> .forge/feature.yaml (pending); a text that is -h or --help goes after --
  scenarios [--kinds a,b] [--more n] [--drafter m]    feature -> .forge/scenarios.yaml
  cases [--n 5] [--scenario id] [--drafter m]         approved scenarios -> .forge/cases/<id>.yaml
  dedupe [--scenario id] [--drafter m]                mark likely duplicates (duplicate_of)
  import <file.jsonl> [--oracle label|fields|rubric]  real inputs -> .forge/cases/imported.yaml
  review [--scenario id] [--only feature|scenarios|cases] | review --scenario id --all
  move --scenario <old> <new> | move --case <id> --to <scenario>
                                                     rename a scenario or move a case between scenarios, rewriting ids
  estimate                                            suite + approved cases -> tokens and dollars per model (no call)
  emit [--format promptfoo|jsonl]                    approved cases -> .forge/promptfooconfig.yaml + the target kind's shim, or cases.jsonl
  report <results.json> [--baseline report.json]      promptfoo output -> .forge/report.md + report.json
  status [--json]                                     every registered suite: feature, counts, last run, version warning; --json for agents
  guide                                               print the manual for an agent operating the forge in a project
  --suite <path>  run on a registered suite from anywhere in the project
  help | --help, version | --version
drafter: --drafter provider/model, FORGE_DRAFTER, or defaults.drafter in forge.yaml; providers: anthropic, google, openai, ollama, fake/<file>`;

export const COMMANDS: Record<
	string,
	(commandArguments: string[], context: CliContext) => Promise<void>
> = {
	init: initCommand,
	describe: describeCommand,
	scenarios: scenariosCommand,
	cases: casesCommand,
	dedupe: dedupeCommand,
	import: importCommand,
	review: reviewCommand,
	move: moveCommand,
	estimate: estimateCommand,
	emit: emitCommand,
	report: reportCommand,
	status: statusCommand,
	guide: guideCommand,
};

/**
 * Built-in error types that (almost) always mean a bug in this codebase
 * rather than an external failure (a bad network call, a missing editor, a
 * provider's own error) — undefined-is-not-a-function, an out-of-range
 * index, a reference to something that was never declared. These must keep
 * surfacing with their real stack instead of being flattened into a single
 * friendly line, or a genuine defect gets harder to find, not easier.
 */
// This discriminator assumes: nothing in this codebase ever throws a
// plain `new Error(...)` for a bug (`grep -rn "throw new Error("` inside
// src/ should stay empty -- real errors go through ForgeError/UsageError),
// and no dependency subclasses a built-in error type to report an
// external failure (the `ai` SDK's AISDKError and the `yaml` package's
// YAMLError both extend Error directly, not TypeError et al.). Either one
// breaking, unnoticed, would misclassify a real bug as a clean CLI error
// or a clean CLI error as a bug.
const PROGRAMMING_ERROR_TYPES = [
	TypeError,
	RangeError,
	ReferenceError,
	SyntaxError,
	EvalError,
	URIError,
];

function isProgrammingError(error: unknown): boolean {
	return PROGRAMMING_ERROR_TYPES.some(
		(errorType) => error instanceof errorType,
	);
}

/** The verbs that write into the suite; each stamps suite.yaml once it succeeds. */
const STAMPING_VERBS = new Set([
	"describe",
	"scenarios",
	"cases",
	"dedupe",
	"import",
	"review",
	"move",
	"emit",
	"report",
]);

/**
 * Prints the version warning for the suite about to be used. A suite.yaml
 * that is absent or does not parse (a ForgeError) is left alone here: the
 * verb reports its own error for it. Anything else is a bug and propagates.
 */
async function warnAboutSuiteVersion(context: CliContext): Promise<void> {
	const read = context.readSuiteIfPresent ?? readSuiteIfPresent;
	const present = await read(context.forgeDirectory).catch((error: unknown) => {
		if (error instanceof ForgeError) return null;
		throw error;
	});
	const warning = versionWarning(present?.suite.forge_version, FORGE_VERSION);
	if (warning !== null) context.stdout(warning);
}

/**
 * Stamps suite.yaml once a verb has succeeded. A suite.yaml the stamp cannot
 * read (the verb never needed it) is reported and left as it was: the verb's
 * own exit status stands.
 */
async function stampAfterSuccess(context: CliContext): Promise<void> {
	try {
		await stampSuite(context.forgeDirectory, FORGE_VERSION);
	} catch (error) {
		if (!(error instanceof ForgeError)) throw error;
		context.stdout(
			`warning: could not stamp ${join(context.forgeDirectory, "suite.yaml")}: ${error.message}`,
		);
	}
}

/** `--help` or `-h` anywhere before a `--` (what follows `--` is the verb's own). */
function helpRequested(argv: string[]): boolean {
	const dashes = argv.indexOf("--");
	const flags = dashes >= 0 ? argv.slice(0, dashes) : argv;
	return flags.includes("--help") || flags.includes("-h");
}

export async function run(
	argv: string[],
	context: CliContext,
): Promise<number> {
	const [verb, ...rest] = argv;
	if (helpRequested(argv) || verb === "help") {
		context.stdout(USAGE);
		return 0;
	}
	if (verb === "--version" || verb === "-V" || verb === "version") {
		context.stdout(FORGE_VERSION);
		return 0;
	}
	const command =
		verb && Object.hasOwn(COMMANDS, verb) ? COMMANDS[verb] : undefined;
	if (!command) {
		context.stdout(USAGE);
		return 2;
	}
	try {
		// status reports every suite's version itself, and its --json output
		// must stay one parseable document; guide prints a manual and reads no suite.
		if (verb !== "status" && verb !== "guide")
			await warnAboutSuiteVersion(context);
		await command(rest, context);
		// Only after the verb returned: one that throws midway (emit whose
		// shim write fails after promptfooconfig.yaml) leaves suite.yaml
		// unstamped. A verb that succeeds having written nothing (review with
		// nothing pending) still stamps; the owner accepted that on
		// 2026-09-29. tests/cli/stamp.test.ts pins both.
		if (STAMPING_VERBS.has(verb ?? "")) await stampAfterSuccess(context);
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			context.stdout(`error: ${error.message}`);
			return 2;
		}
		if (error instanceof ForgeError) {
			context.stdout(`error: ${error.message}`);
			return 1;
		}
		if (error instanceof TypeError && /option|argument/i.test(error.message)) {
			context.stdout(`error: ${error.message}\n${USAGE}`);
			return 2;
		}
		// A parseArgs usage TypeError is handled above; any other
		// programming-error type still propagates raw (see
		// PROGRAMMING_ERROR_TYPES). Everything else reaching here is an
		// external failure this process doesn't control -- a provider's
		// API error, a missing editor binary, a network error -- and gets
		// the same clean `error: ...` treatment as a ForgeError, so a real
		// user never sees a raw stack trace for something they can't fix
		// by reading a stack trace anyway.
		if (!isProgrammingError(error) && error instanceof Error) {
			context.stdout(`error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

export function drafterFlag(argv: string[]): string | undefined {
	const index = argv.indexOf("--drafter");
	return index >= 0 ? argv[index + 1] : undefined;
}

export interface MainOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: () => Promise<string>;
	stdout?: (line: string) => void;
	/**
	 * The interactive pass of the reader behind `stdin`, the one Ctrl+C is
	 * wired to (see `CliContext.startInteractivePass`). Required, not
	 * defaulted: `createContext`'s fallback arms a reader nothing
	 * interrupts, so an entry point that forgot this compiled and lost a
	 * review to the first Ctrl+C.
	 */
	startInteractivePass: () => InteractivePass;
	/**
	 * Where each provider's `api.env` is read from, into `env`: bin.ts
	 * passes `~/.config`. Required, so no caller — a test above all — reads
	 * the real one by leaving it out.
	 */
	configDirectory: string;
}

/**
 * `--suite <path>` and `--suite=<path>` taken out of `argv`, wherever they
 * stand before a `--` (what follows `--` belongs to the verb untouched).
 */
function takeSuiteFlag(argv: string[]): { rest: string[]; suite?: string } {
	const queue = [...argv];
	const rest: string[] = [];
	let suite: string | undefined;
	for (
		let argument = queue.shift();
		argument !== undefined;
		argument = queue.shift()
	) {
		if (argument === "--") {
			rest.push(argument, ...queue);
			break;
		}
		const inline = argument.startsWith("--suite=");
		if (argument !== "--suite" && !inline) {
			rest.push(argument);
			continue;
		}
		const value = inline ? argument.slice("--suite=".length) : queue.shift();
		if (value === undefined || value === "" || value.startsWith("--"))
			throw new UsageError("--suite needs a path: --suite <path>");
		if (suite !== undefined)
			throw new UsageError("--suite was given more than once; pass one path");
		suite = value;
	}
	return { rest, suite };
}

/** Verbs that work where there is no suite yet, or on no suite at all. */
const VERBS_EXEMPT_FROM_SUITE_GUARD = new Set([
	"describe",
	"status",
	"guide",
	"help",
	"version",
]);

/**
 * Answered before any forge.yaml or provider key file is read, so a broken
 * one never hides them and asking touches no key file.
 */
const INFORMATION_VERBS = new Set([
	"help",
	"--version",
	"-V",
	"version",
	"guide",
]);

async function refuseVerbWithoutSuite(
	verb: string | undefined,
	context: CliContext,
): Promise<void> {
	if (context.project === null) return;
	if (verb === undefined || !Object.hasOwn(COMMANDS, verb)) return;
	if (VERBS_EXEMPT_FROM_SUITE_GUARD.has(verb)) return;
	const present = await access(context.forgeDirectory).then(
		() => true,
		() => false,
	);
	if (present) return;
	throw new UsageError(
		`no suite here: ${context.forgeDirectory} does not exist; registered suites in ${context.project.file}: ${registeredSuiteNames(context.project)}; cd into one or pass --suite <path>`,
	);
}

/** The CLI's entry: resolves the suite and the project, then hands the verb to `run`. */
export async function main(
	argv: string[],
	options: MainOptions,
): Promise<number> {
	const write = options.stdout ?? console.log;
	try {
		// Asking for help is answered before anything is resolved or parsed, so
		// `status --help` works next to a malformed forge.yaml.
		if (helpRequested(argv)) {
			write(USAGE);
			return 0;
		}
		// The verb is what is left first once --suite and its path are taken
		// out, so `--suite x --help` is answered like `--help`. A first word
		// that already is one skips the flag parsing, which could refuse it.
		const informationFirst =
			argv[0] !== undefined && INFORMATION_VERBS.has(argv[0]);
		const { rest, suite } = informationFirst
			? { rest: argv, suite: undefined }
			: takeSuiteFlag(argv);
		const information = rest[0] !== undefined && INFORMATION_VERBS.has(rest[0]);
		// Keys the shell does not export are read from
		// <configDirectory>/<provider>/api.env; a key already in the
		// environment wins. Only for a verb that may need one: help, version
		// and guide (bin.ts used to load keys before anything) touch no key
		// file at all, as `--help` answered above does not, and neither does
		// a command line naming no verb, which `run` answers with the usage.
		if (!information && Object.hasOwn(COMMANDS, rest[0] ?? ""))
			await loadProviderKeys({
				environment: options.env,
				configDirectory: options.configDirectory,
			});
		// `init` reads no forge.yaml through the resolution: it creates one, and
		// a broken one must not stop it from updating AGENTS.md.
		const initializing = rest[0] === "init";
		if (initializing && suite !== undefined)
			throw new UsageError(
				"init works at the project root and does not take --suite",
			);
		const resolution =
			information || initializing
				? { forgeDirectory: undefined, project: null }
				: await resolveSuite({ cwd: options.cwd, suite });
		const context = createContext({
			cwd: options.cwd,
			drafter: drafterFlag(rest),
			env: options.env,
			stdin: options.stdin,
			startInteractivePass: options.startInteractivePass,
			forgeDirectory: resolution.forgeDirectory,
			project: resolution.project,
		});
		if (options.stdout) context.stdout = options.stdout;
		await refuseVerbWithoutSuite(rest[0], context);
		return await run(rest, context);
	} catch (error) {
		if (error instanceof UsageError) {
			write(`error: ${error.message}`);
			return 2;
		}
		if (error instanceof ForgeError) {
			write(`error: ${error.message}`);
			return 1;
		}
		throw error;
	}
}
