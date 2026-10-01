🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml)

# llm-tests-forge

Forge reviewed regression suites for the LLM features in your application, from inside your application.

Describe what a function does, and the forge enumerates scenarios of six kinds (happy, edge, ambiguous, out-of-scope, adversarial, language), generates cases per scenario with an expected output, and lets you review every one of them in plain files, one by one. Then it prices the run before you spend it, emits a config for [promptfoo](https://promptfoo.dev) to run against your real code, and turns promptfoo's output back into a report with a per-scenario table, flaky cases and real-against-estimated cost.

Two finished suites, generated and reviewed against a real application: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) and [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## Install

Each channel below installs the same prebuilt `llm-tests-forge` binary, so the forge itself needs no bun. None of them is published yet, so today the only path that works is building from a clone, further down.

Pick the one that matches your project:

    npm i -D llm-tests-forge                # JavaScript / TypeScript
    uv add --dev llm-tests-forge            # Python
    brew install albertosca/tap/llm-tests-forge   # any project
    curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh   # any project

For Elixir, add the dependency to `mix.exs`, then fetch the binary:

    {:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}
    mix deps.get
    mix llm_tests_forge.install

For Ruby, add this line to your `Gemfile` and run `bundle install`:

    gem "llm-tests-forge", group: :development

Rust and Go projects have no package of their own: use Homebrew or the script. `install.sh` puts the binary in `~/.local/bin` by default and verifies its SHA256 first, against the `SHA256SUMS` of the same release: that proves the download is intact, not that it is authentic (for a hash pinned in the package itself, use Homebrew or Hex); `--dir <bin-directory>` chooses another directory and `--version vX.Y.Z` pins a release; through the pipe, pass them after `sh -s --`. Under Elixir, an interactive `review` runs as `_build/llm-tests-forge review`, because `mix llm_tests_forge review` refuses (it exits 2); `review --scenario <id> --all` asks nothing and runs through mix.

From a clone, which works today, requires [bun](https://bun.sh) 1.4 or newer:

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install
    bun link      # links `llm-tests-forge` into bun's global bin directory

`bun link` puts the command in bun's global bin directory, `~/.bun/bin` by default, which must be on your `PATH` (a Homebrew install of bun does not add it).

The forge ships no short alias of its own. If you want one, `alias ltf=llm-tests-forge` in your shell is your choice to make.

Running a suite needs promptfoo, which is Node: the forge itself does not, and never runs promptfoo for you.

## Use it in a project

Run these from inside the project whose LLM feature you are testing.

    llm-tests-forge init

Detects the project's language, writes `forge.yaml` at the project root, and adds a block about the forge to `AGENTS.md` (creating the file if there is none). `--language` overrides the detection. On a project that already has a `forge.yaml`, `init` leaves it untouched and only refreshes the `AGENTS.md` block, so `--language` does nothing there. `forge.yaml` lists the suites and holds the defaults; it starts with `suites: []` and the defaults commented out, and `describe` adds each new suite to the list. A suite that already existed (copied in, or made before `init`) is added by no verb: write its path under `suites:` yourself (for example `suites: [evals/classify]`). A filled-in one looks like this:

    # forge.yaml
    version: 1
    language: python
    suites: [evals/classify_response]
    defaults:
      drafter: anthropic/claude-sonnet-5
      target_models: [anthropic/claude-haiku-4-5]
      judges: [anthropic/claude-sonnet-5]

There is one suite per function under test, by convention in `evals/<function>/`, each a directory with a `.forge/` inside it.

    llm-tests-forge status

One line per registered suite: its feature (marked `(feature pending)` while it waits for review), its scenarios and cases as approved and pending (rejected scenarios are shown apart, never in those counts), its last run and any version warning. `status --json` prints the same for a program, with `featureStatus` and `scenarios: { approved, pending, rejected }`. It is how a person, or an agent with no chat history, finds out what exists and what is pending.

    llm-tests-forge guide

Prints the manual for an agent operating the forge, embedded in the installed binary so it always matches the installed version. `--suite <path>` (a path relative to the project root) runs any verb on a registered suite from anywhere inside the project; without it, a verb uses the suite of the current directory. A directory with `.forge/` and no `forge.yaml` above it still works as a stand-alone suite.

### The drafter

The drafter is the model that writes the feature, scenarios and cases; everything it writes arrives pending. Set it with `--drafter provider/model`, else `FORGE_DRAFTER`, else `defaults.drafter` in `forge.yaml`. Keys come from the environment first, and `~/.config/<provider>/api.env` is the fallback.

| Provider | Env var | Example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | none (local) | `ollama/llama3` |
| `fake` | none | `fake/path/to/responses.json`, for tests |

### The pipeline, one suite

Create the suite directory, `cd` into it, and run these in order.

    mkdir -p evals/classify_response && cd evals/classify_response
    export FORGE_DRAFTER=google/gemini-3.5-flash
    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Writes `.forge/feature.yaml` as a pending, structured description of the feature (purpose, inputs, output shape, invariants). Each input's name becomes a promptfoo template variable, so it takes letters, digits and underscores, does not start with a digit, and is none of `not`, `true`, `false`, `none`, `null` (`user_message`, not `user message`); a `feature.yaml` with any other name is refused. `--prompt-file` is optional; pass it when the function has a real system prompt worth copying rules from (the path is relative to where you run the command, hence `../../` from `evals/classify_response`). Running `describe` again over a feature you have already reviewed is refused, because it would overwrite the invariants you wrote by hand; pass `--force` when replacing it is what you want. When no `suite.yaml` exists yet, the project's language is not `other`, and `forge.yaml` sets both `defaults.target_models` and `defaults.judges`, `describe` also writes a starting `suite.yaml`.

    llm-tests-forge review

Opens an interactive review of whatever is pending — here, the feature. Approve it, edit it, or reject it; approval unblocks the next step.

    llm-tests-forge scenarios

Generates `.forge/scenarios.yaml`: a set of scenarios covering all six kinds for the approved feature. `--more <n>` drafts more later.

    llm-tests-forge review --only scenarios

Reviews the pending scenarios one by one.

    llm-tests-forge cases --n 5

Generates 5 pending cases per approved scenario in `.forge/cases/<scenario-id>.yaml`, each with an expected output computed from the feature's oracle shape (label, fields, or rubric). `--scenario <id>` drafts cases for one scenario only.

    llm-tests-forge dedupe

Flags likely-duplicate cases within each scenario (`duplicate_of`) without removing them. It only touches pending cases, so it comes before the review of the cases.

    llm-tests-forge import ../../logs/real-inputs.jsonl

Reads one `{"input-name": "value"}` JSON object per line from real production logs and adds them as pending cases in the `imported` scenario, without an expected output — you supply that during review.

    llm-tests-forge review

Reviews everything still pending: cases (confirming or fixing the expected output), and any imported case (setting its expected output for the first time). Two things review will not change for you: a scenario's `id` and a case's `scenario`, because both name the file the cases live in (`.forge/cases/<scenario>.yaml`) — the refusal names the `llm-tests-forge move` call that does it. And editing a scenario's `oracle` re-opens the approved cases of that scenario whose expected the new oracle no longer accepts: each one then needs `edit` to be given an expected in the new shape, not `approve`. One Ctrl+C during a review saves what was decided so far; a second one aborts without writing, if it arrives before the save finishes. Inside `$EDITOR`, Ctrl+C belongs to the editor and does neither.

    llm-tests-forge move --scenario <old> <new>
    llm-tests-forge move --case <id> --to <scenario>

Renames a scenario or moves a case into another scenario, rewriting what the ids name: the scenario's cases file, every case id numbered from it, `duplicate_of` pointers, and `suite.include`. A moved case is numbered after the destination's last case; when the destination's oracle does not accept its expected, it goes back to pending and the line says why. The destination is written before the source is touched, so a failure part-way leaves a duplicate to clean up, never a missing case.

At the end, `.forge/` holds `feature.yaml`, `scenarios.yaml`, and `cases/<scenario>.yaml` — plain YAML, meant to be committed and diffed like any other test fixture.

The remaining verbs turn that suite into a run. They read `.forge/suite.yaml`, which `describe` may have started for you and which you otherwise write by hand: what the suite runs against, which models judge a `rubric` case, and how many times each case repeats.

    # .forge/suite.yaml
    target:
      kind: python
      entry: forge_target.py          # optional: the shim, when not the default name
      python: .venv/bin/python        # an interpreter that can import your application
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # empty = every approved scenario

`target.kind` is one of the nine kinds below; `kind: promptfoo-python`, which older suites carry, still reads as `python`. The kind-specific keys are `target.python` (python), `target.command` (exec), and `target.url`, `target.method`, `target.headers`, `target.body` and `target.response` (http).

    llm-tests-forge estimate

Prices the run before you spend it: cases × target models × `repeat`, plus one judge call per `rubric` case per judge, target model and `repeat`, against `prices.yaml` (which is yours to edit — the output prints the date it carries, and marks with `~` any model it had to price as its closest listed sibling). A model whose provider has no row at all is not priced as anything: its line reads `not priced`, and the total leaves it out and says how many lines it left out. Tokens are counted as characters ÷ 4, and every line and the total show a range around that point, `$low–$high (point $point)`: the input re-counted at 3.5 to 4.2 characters per token, the judge's prompt overhead and answer size taken from recorded runs, and the target's output at 0.5× to 1.25× of a size guessed from `output.kind` (or from the reviewed expected values), because nothing of the real answer's text exists before the run. The bands were fit to the few runs committed with this repository, so read the range as a calibrated guess, not a budget. It makes no API call.

    llm-tests-forge emit

Writes `.forge/promptfooconfig.yaml` from the approved cases: one test per case with its inputs as `vars`, a `javascript` assert for a `label` or `fields` oracle, and one `llm-rubric` per judge for a `rubric` one. It refuses to emit while anything is still pending, and names what. On the first run it also writes the shim for your language, once and never overwritten again — **fill in the function it names to call your application**, which is what makes the suite test your code rather than a copy of your prompt. `--format jsonl` writes the same selection as `.forge/cases.jsonl` instead, for a runner of your own.

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

Promptfoo runs the suite from the suite directory (`bunx` works too); the forge does not run it for you. promptfoo exits with status 100 when any test fails: that is a result, not a crash.

    llm-tests-forge report results.json [--baseline .forge/report.json]

Reads promptfoo's output into `.forge/report.md` and `.forge/report.json`: pass rate, a per-scenario table, which reviewed scenarios had no case, no matched run, or were not in this suite, cases that passed on one repeat and failed on another, judges that disagreed (with both reasons), and real cost against the estimate's range: within it, or how far above or below its nearer bound, and a line that recorded no tokens says so instead of claiming a match. With `--baseline`, an earlier `report.json` is compared and regressions are listed first; pairs the baseline has and this run does not (after a rename, say) are named rather than silently left out of the diff; a `--baseline` written by an older version of the forge is accepted, keys it spelled differently included.

### The nine target kinds

The shim lives in `.forge/<entry>`, using the default names below unless `target.entry` renames it. `emit` writes it once and never overwrites it; you fill in the one function it names.

| `target.kind` | What `emit` writes | What you fill in |
|---|---|---|
| `python` | `forge_target.py` | `run_application`; `target.python` sets the interpreter promptfoo runs, which must be able to import your code |
| `javascript` | `forge_target.mjs` | `runApplication` |
| `typescript` | `forge_target.ts`, which promptfoo loads directly | `runApplication` |
| `elixir` | `forge_target.exs`, run through `mix run` from the mix project (Elixir 1.18 or newer, for JSON) | `run_application/2`; run `mix compile` before the first run |
| `ruby` | `forge_target.rb` | `run_application` |
| `rust` | the `forge_target/` crate (`Cargo.toml`, `src/main.rs`) | uncomment the dependency on your crate, fill `run_application`, build once with `cargo build --release` inside `.forge/forge_target/` |
| `go` | the `forge_target/` module (`go.mod`, `main.go`) | uncomment the `require` and `replace` lines, fill `runApplication`, build once with `GOWORK=off go build -o forge_target .` inside `.forge/forge_target/` |
| `exec` | nothing | `target.command` in `suite.yaml` names the program; it runs from `.forge/`, so a relative command is relative to `.forge/` |
| `http` | nothing | `target.url`, and optionally `method`, `headers`, `body` (each of the feature's inputs is available as `{{<input name>}}`; the default body is one key per input) and `response` (an expression over `json`, with no `=>`); `emit` replaces `{{target_model}}` in `url`, a header value or `body` with each provider's model |

What an `exec` command receives: promptfoo runs it from `.forge/`, once per case and target model, with three arguments — the rendered prompt (the feature's first input), the provider options as JSON (the model is at `config.model`), and the context as JSON (the case's inputs are under `vars`, which also holds promptfoo's own keys starting with `__`, to ignore). Standard input is empty. The answer goes to standard output and logs to standard error; a failure is a message on standard error and a non-zero exit status, which promptfoo shows as an error row.

For `http`, `{{target_model}}` is substituted by `emit` itself, nested strings of `body` included, before the config is written. With more than one `target.models` and no `{{target_model}}` anywhere, every provider sends the same request, and `emit` prints a warning saying so.

Every exec-style shim answers on stdout, so your application must log to stderr. Compile the project (`mix compile`, `cargo build`, `go build`) before the first run: promptfoo runs cases concurrently, and a first compile racing itself is not verified safe. A shim that fails (a non-zero exit status, or an error it returns) shows as an error row in promptfoo, not as a failed assert.

### Agents

`init` adds a block to `AGENTS.md` that points an agent at `llm-tests-forge status` and `llm-tests-forge guide`. The rule in that manual is the important one: approving is the person's job, so an agent never marks anything approved by editing a file and never runs `review` for you.

A Claude Code skill (`plugin/skills/llm-tests-forge/`) is a thin pointer to the same manual. The install command is `/plugin marketplace add albertosca/llm-tests-forge`, and it works once the repository is public. Until then, `/plugin marketplace add <path to your clone>` installs it from a local checkout.

### What to commit under `.forge/`

Commit `forge.yaml`, and in each suite `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, the shim and `report.md`/`report.json`: they are the reviewed suite, the run it describes and the result, and their diffs are the point. Gitignore `usage.jsonl` and `failures/`, which hold token counts and raw model output from your own runs, and decide deliberately about `cases/imported.yaml` — `import` fills it with real production inputs, which may be data you cannot put in a repository.

### Exit codes

| Code | Means |
|---|---|
| `0` | the verb did what it says |
| `1` | the work failed: a file that is not there, a model that refused, a feature still pending review |
| `2` | the command line is unusable: an unknown verb or option, a bad flag value, a missing required argument, no model configured |

## What this does not do yet

- It does not call promptfoo for you: `llm-tests-forge emit` writes the config and you run the eval yourself.
- There is no MCP server, so the review loop cannot run inside a conversation.
- It tests one turn at a time. Multi-turn cases where your application's own reply shapes the next turn need a simulated user, which this is not.
- It keeps no history: `--baseline` compares two runs, and nothing collects them over time.
- It is not published to any package registry yet.

## Develop

    bun test          # unit tests, no network, coverage gate
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, then typecheck, then test
    bun run test:live  # two real calls against google/gemini-3.5-flash by default (FORGE_LIVE=1); override with FORGE_DRAFTER
    bun run test:shims # runs every shim against its real toolchain and promptfoo (FORGE_SHIMS=1); slow, needs the toolchains
    bun run validate:example  # checks the committed example's promptfooconfig.yaml with the real promptfoo; no API key

The coverage gate is bun's own: a 1.0 floor on **lines and functions**, with `src/cli/bin.ts` excluded. Bun measures no branch coverage at all, so a file at 100% can still have untested guard arms — read the gate as a floor, not as proof the suite is complete.

`test:live` needs `GOOGLE_API_KEY` and fails loudly (not silently) if it's unset. Google's free tier is intermittent rather than simply down, so the test retries a 503/"high demand" response up to 3 attempts with a short pause between them; any other failure (quota, auth, an unknown model id, a schema mismatch) fails on the first occurrence instead of retrying.

## License

MIT — see `LICENSE`.
