import { access } from "node:fs/promises";
import { ForgeError, UsageError } from "../core/errors";
import { registeredSuiteNames } from "../core/project";
import { resolveSuite } from "../core/resolve";
import { FORGE_VERSION } from "../core/version";
import { casesCommand } from "./commands/cases";
import { dedupeCommand } from "./commands/dedupe";
import { describeCommand } from "./commands/describe";
import { emitCommand } from "./commands/emit";
import { estimateCommand } from "./commands/estimate";
import { importCommand } from "./commands/import";
import { moveCommand } from "./commands/move";
import { reportCommand } from "./commands/report";
import { reviewCommand } from "./commands/review";
import { scenariosCommand } from "./commands/scenarios";
import { type CliContext, createContext } from "./context";

export const USAGE = `usage: llm-tests-forge <verb> [options]
  describe <text...> [--prompt-file f] [--force] [--drafter m]
                                                     free text (or stdin) -> .forge/feature.yaml (pending)
  scenarios [--kinds a,b] [--more n] [--drafter m]    feature -> .forge/scenarios.yaml
  cases [--n 5] [--scenario id] [--drafter m]         approved scenarios -> .forge/cases/<id>.yaml
  dedupe [--scenario id] [--drafter m]                mark likely duplicates (duplicate_of)
  import <file.jsonl> [--oracle label|fields|rubric]  real inputs -> .forge/cases/imported.yaml
  review [--scenario id] [--only feature|scenarios|cases] | review --scenario id --all
  move --scenario <old> <new> | move --case <id> --to <scenario>
                                                     rename a scenario or move a case between scenarios, rewriting ids
  estimate                                            suite + approved cases -> tokens and dollars per model (no call)
  emit [--format promptfoo|jsonl]                    approved cases -> .forge/promptfooconfig.yaml + forge_target.py, or cases.jsonl
  report <results.json> [--baseline report.json]      promptfoo output -> .forge/report.md + report.json
  --suite <path>  run on a registered suite from anywhere in the project
  help | --help, version | --version
drafter: --drafter provider/model, FORGE_DRAFTER, or defaults.drafter in forge.yaml; providers: anthropic, google, openai, ollama, fake/<file>`;

const COMMANDS: Record<
	string,
	(commandArguments: string[], context: CliContext) => Promise<void>
> = {
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

export async function run(
	argv: string[],
	context: CliContext,
): Promise<number> {
	const [verb, ...rest] = argv;
	if (verb === "--help" || verb === "-h" || verb === "help") {
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
		await command(rest, context);
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
	onInteractivePass?: () => void;
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
	"init",
	"status",
	"guide",
	"help",
	"version",
]);

/** Answered before any forge.yaml is read, so a broken one never hides them. */
const INFORMATION_VERBS = new Set([
	"--help",
	"-h",
	"help",
	"--version",
	"-V",
	"version",
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
		const information = argv[0] !== undefined && INFORMATION_VERBS.has(argv[0]);
		const { rest, suite } = information
			? { rest: argv, suite: undefined }
			: takeSuiteFlag(argv);
		const resolution = information
			? { forgeDirectory: undefined, project: null }
			: await resolveSuite({ cwd: options.cwd, suite });
		const context = createContext({
			cwd: options.cwd,
			drafter: drafterFlag(rest),
			env: options.env,
			stdin: options.stdin,
			onInteractivePass: options.onInteractivePass,
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
