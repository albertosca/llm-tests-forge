import { ForgeError, UsageError } from "../core/errors";
import { casesCommand } from "./commands/cases";
import { dedupeCommand } from "./commands/dedupe";
import { describeCommand } from "./commands/describe";
import { importCommand } from "./commands/import";
import { reviewCommand } from "./commands/review";
import { scenariosCommand } from "./commands/scenarios";
import type { CliContext } from "./context";

export const USAGE = `usage: forge <verb> [options]
  describe <text...> [--prompt-file f] [--model m]   free text (or stdin) -> .forge/feature.yaml (pending)
  scenarios [--kinds a,b] [--more n] [--model m]      feature -> .forge/scenarios.yaml
  cases [--n 5] [--scenario id] [--model m]           approved scenarios -> .forge/cases/<id>.yaml
  dedupe [--scenario id] [--model m]                  mark likely duplicates (duplicate_of)
  import <file.jsonl> [--oracle label|fields|rubric]  real inputs -> .forge/cases/imported.yaml
  review [--scenario id] [--only feature|scenarios|cases] [--all]
model: --model provider/model or FORGE_MODEL; providers: anthropic, google, openai, ollama, fake/<file>`;

const COMMANDS: Record<
	string,
	(args: string[], ctx: CliContext) => Promise<void>
> = {
	describe: describeCommand,
	scenarios: scenariosCommand,
	cases: casesCommand,
	dedupe: dedupeCommand,
	import: importCommand,
	review: reviewCommand,
};

export async function run(argv: string[], ctx: CliContext): Promise<number> {
	const [verb, ...rest] = argv;
	const command = verb ? COMMANDS[verb] : undefined;
	if (!command) {
		ctx.stdout(USAGE);
		return 2;
	}
	try {
		await command(rest, ctx);
		return 0;
	} catch (e) {
		if (e instanceof UsageError) {
			ctx.stdout(`error: ${e.message}`);
			return 2;
		}
		if (e instanceof ForgeError) {
			ctx.stdout(`error: ${e.message}`);
			return 1;
		}
		if (e instanceof TypeError && /option|argument/i.test(e.message)) {
			ctx.stdout(`error: ${e.message}\n${USAGE}`);
			return 2;
		}
		throw e;
	}
}

export function modelFlag(argv: string[]): string | undefined {
	const i = argv.indexOf("--model");
	return i >= 0 ? argv[i + 1] : undefined;
}
