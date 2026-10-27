🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# LLM Tests Forge

Regression suites for the LLM features in your application: drafted by a model, approved by you, and kept as plain files in your repository.

![The forge in a terminal: status, a review of two cases, estimate and report](assets/demo.gif)

You describe what a function does. The forge enumerates scenarios of six kinds (happy, edge, ambiguous, out-of-scope, adversarial, language), drafts cases for each with an expected output, and walks you through reviewing every one. It prices the run before you spend it, emits a config for [promptfoo](https://promptfoo.dev) to run against your real code, and reads promptfoo's output back into a report: a per-scenario table, flaky cases, real cost against the estimate.

Two finished suites, generated and reviewed against a real application: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) and [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## How it differs, and why

An LLM feature changes behavior whenever the prompt, the model or the code around it changes, so the evaluation set that guards it has to be cheap to write and cheap to keep honest. Four choices follow from that.

The expected outputs are YAML files in the repository, next to the code they test, and a person approves each one. A model drafts; it never decides what "correct" means. The suite then shows up in pull requests like any other fixture, instead of living in a service or a dataset that has to be kept in step with the code.

Coverage is organised by kind of scenario rather than by volume, so the adversarial and out-of-scope inputs get written alongside the happy path instead of after it.

A run is priced before it is spent, and a passing run can be sealed to the files, models and pass rate it was earned on, so CI can check offline that none of them moved.

Execution is left to promptfoo. The forge decides what to test and emits the config; it does not ship a runner of its own.

## Install

One prebuilt binary, several ways to get it. Nothing is published yet, so until the first release the only path that works is the clone at the end of this section.

    npm i -D llm-tests-forge                # JavaScript / TypeScript
    uv add --dev llm-tests-forge            # Python
    brew install albertosca/tap/llm-tests-forge   # any project
    curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh   # any project

**Elixir.** Add the dependency to `mix.exs`, then fetch the binary:

    {:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}
    mix deps.get
    mix llm_tests_forge.install

An interactive `review` runs as `_build/llm-tests-forge review`, because `mix llm_tests_forge review` refuses (exit 2). `review --scenario <id> --all` asks nothing and runs through mix.

**Ruby.** Add `gem "llm-tests-forge", group: :development` to the `Gemfile` and run `bundle install`.

**Rust and Go.** There is no package of their own: use Homebrew or the script.

**`install.sh` options.**
- It writes to `~/.local/bin`; `--dir <bin-directory>` chooses another.
- `--version vX.Y.Z` pins a release.
- Through the pipe, pass the options after `sh -s --`.

**From a clone** (needs [bun](https://bun.sh) 1.4 or newer):

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install
    bun link      # puts `llm-tests-forge` in bun's global bin directory, ~/.bun/bin by default

Running a suite needs promptfoo, which is Node. The forge itself does not, and never runs promptfoo for you.

**Platforms.**
- The binaries cover macOS (arm64, x64), Linux with glibc (x64, arm64) and Windows x64.
- Anywhere else, musl/Alpine included, pip and gem install a fallback package with no binary. Its command says so and exits 1, as npm's and `install.sh` do.
- On a supported platform, the fallback says how to get the binary instead: pip's `--platform`, Bundler's `force_ruby_platform`, `bundle lock --add-platform` (for a `Gemfile.lock` whose `PLATFORMS` lack this platform), or `gem install --platform ruby`.

### Verifying a download

`install.sh` makes two checks, and they prove different things.

- **Integrity.** The binary's SHA256 must match the release's `SHA256SUMS`. That proves the download arrived intact, not who built it, since both come from the same place. Homebrew and Hex pin each binary's hash in the package itself instead.
- **Provenance.** Every release binary and `SHA256SUMS` carry a GitHub artifact attestation, signed through Sigstore by this repository's release workflow. With [`gh`](https://cli.github.com) 2.49 or newer on the PATH, the script verifies it, logged in or anonymously (GitHub allows 60 anonymous API requests an hour per address).

What you see:
- **The attestation verifies:** one line says so.
- **It does not verify:** nothing is installed, and the script prints what `gh` said and what to check.
- **`gh` is missing or older than 2.49:** the binary is installed on its checksum alone. The script says provenance was not checked and prints the command that checks it later, which works on any downloaded binary:

      gh attestation verify ~/.local/bin/llm-tests-forge --repo albertosca/llm-tests-forge --signer-workflow albertosca/llm-tests-forge/.github/workflows/release.yml --deny-self-hosted-runners

Two details worth knowing:
- `install.sh` always asks github.com, even when `GH_HOST` names another host, so a GitHub Enterprise token in `GH_TOKEN` or `GITHUB_TOKEN` is rejected there. Unset it for the install.
- To install on the checksum alone after a refusal, set `LLM_TESTS_FORGE_PROVENANCE=skip` for `sh`. The script then says, with a warning, that provenance was not checked. This does not prove who built the binary.

## Quick start

From inside the project whose LLM feature you are testing:

    llm-tests-forge init
    llm-tests-forge describe "what the function does" --prompt-file path/to/prompt.txt
    llm-tests-forge review        # approve, edit or reject each scenario and case
    llm-tests-forge estimate      # what a run will cost, before you spend it
    llm-tests-forge emit          # the promptfoo config and a shim for your language

`llm-tests-forge guide` prints the manual for an agent operating the forge. The full walk-through is under [Usage](#usage).

## Usage

The whole flow, in order. Each step has its own entry below.

1. `init` once per project.
2. `describe`, then `review`: the forge writes a description of the feature, and you approve it.
3. `scenarios`, then `review --only scenarios`: situations the feature must handle, approved by you.
4. `cases`, then `dedupe`, optionally `import`, then `review`: the cases and their expected outputs, approved by you.
5. `estimate`, then `emit`: the price, then the promptfoo config.
6. Run promptfoo yourself, then `report`.
7. Optionally `stamp` after a good run, and `check` in CI.

### Setting up a project

Run these from inside the project whose LLM feature you are testing.

#### `init`

    llm-tests-forge init

Prepares the project:
- Detects the project's language and writes `forge.yaml` at the project root. `--language` overrides the detection.
- Adds a block about the forge to `AGENTS.md`, creating the file if there is none.
- On a project that already has a `forge.yaml`, leaves it untouched and only refreshes the `AGENTS.md` block, so `--language` does nothing there.

`forge.yaml` lists the suites and holds the defaults. It starts with `suites: []` and the defaults commented out, and `describe` adds each new suite to the list. A suite that already existed (copied in, or made before `init`) is added by no verb: write its path under `suites:` yourself (for example `suites: [evals/classify]`). A filled-in one looks like this:

    # forge.yaml
    version: 1
    language: python
    suites: [evals/classify_response]
    defaults:
      drafter: anthropic/claude-sonnet-5
      target_models: [anthropic/claude-haiku-4-5]
      judges: [anthropic/claude-sonnet-5]

There is one suite per function under test, by convention in `evals/<function>/`, each a directory with a `.forge/` inside it.

#### `status`

    llm-tests-forge status

One line per registered suite, showing:
- its feature, marked `(feature pending)` while it waits for review;
- its scenarios and cases as approved and pending (rejected scenarios are shown apart, never in those counts);
- its last run and any version warning.

`status --json` prints the same for a program, with `featureStatus` and `scenarios: { approved, pending, rejected }`. It is how a person, or an agent with no chat history, finds out what exists and what is pending.

#### `guide`

    llm-tests-forge guide

Prints the manual for an agent operating the forge. It is embedded in the installed binary, so it always matches the installed version.

#### Choosing the suite

- `--suite <path>` (a path relative to the project root) runs any verb on a registered suite from anywhere inside the project.
- Without it, a verb uses the suite of the current directory.
- A directory with `.forge/` and no `forge.yaml` above it still works as a stand-alone suite.

### The drafter

The drafter is the model that writes the feature, scenarios and cases. Everything it writes arrives pending.

Set it with, in this order of precedence: `--drafter provider/model`, else `FORGE_DRAFTER`, else `defaults.drafter` in `forge.yaml`. Keys come from the environment first, and `~/.config/<provider>/api.env` is the fallback.

| Provider | Env var | Example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | none (local) | `ollama/llama3` |
| `fake` | none | `fake/path/to/responses.json`, for tests |

### Building a suite

Create the suite directory, `cd` into it, and run the verbs in this order:

    mkdir -p evals/classify_response && cd evals/classify_response
    export FORGE_DRAFTER=google/gemini-3.5-flash

    llm-tests-forge describe "..." --prompt-file ../../src/prompt.txt
    llm-tests-forge review
    llm-tests-forge scenarios
    llm-tests-forge review --only scenarios
    llm-tests-forge cases --n 5
    llm-tests-forge dedupe
    llm-tests-forge import ../../logs/real-inputs.jsonl     # optional
    llm-tests-forge review

#### `describe`

    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Writes `.forge/feature.yaml` as a pending, structured description of the feature: purpose, inputs, output shape, invariants.

- **Input names** become promptfoo template variables. They take ASCII letters, digits and underscores, start with a letter (a leading underscore is promptfoo's own), and are none of `not`, `true`, `false`, `none`, `null`. Write `user_message`, not `user message`. A `feature.yaml` with any other name is refused.
- **Renaming an input** means renaming it in `feature.yaml`, in every case's `input:` keys and in the target or shim code. Until then, `estimate`, `emit` and `report` refuse an approved case whose input keys do not match the feature's inputs.
- **`--prompt-file`** is optional. Pass it when the function has a real system prompt worth copying rules from. The path is relative to where you run the command, hence `../../` from `evals/classify_response`.
- **Running it again** over a feature you have already reviewed is refused, because it would overwrite the invariants you wrote by hand. Pass `--force` when replacing it is what you want.
- **It also writes a starting `suite.yaml`** when all three hold: no `suite.yaml` exists yet, the project's language is not `other`, and `forge.yaml` sets both `defaults.target_models` and `defaults.judges`.

#### `scenarios`

    llm-tests-forge scenarios

Generates `.forge/scenarios.yaml`: a set of scenarios covering all six kinds for the approved feature. `--more <n>` drafts more later.

#### `cases`

    llm-tests-forge cases --n 5

Generates 5 pending cases per approved scenario in `.forge/cases/<scenario-id>.yaml`. Each has an expected output computed from the feature's oracle shape (`label`, `fields` or `rubric`). `--scenario <id>` drafts cases for one scenario only.

#### `dedupe`

    llm-tests-forge dedupe

Flags likely-duplicate cases within each scenario (`duplicate_of`) without removing them. It only touches pending cases, so it comes before the review of the cases.

#### `import`

    llm-tests-forge import ../../logs/real-inputs.jsonl

Reads one `{"input-name": "value"}` JSON object per line from real production logs and adds them as pending cases in the `imported` scenario. They have no expected output: you supply it during review.

#### `review`

    llm-tests-forge review
    llm-tests-forge review --only scenarios

Opens an interactive review of whatever is pending. The first time, that is the feature: approve it, edit it, or reject it, and approval unblocks the next step. Later it covers scenarios, cases (confirming or fixing the expected output) and imported cases (setting the expected output for the first time). Pressing Enter on an empty line asks before it skips.

The words the review screen uses:
- **pending**: waiting for your decision.
- **expected**: the answer the drafter proposes for a case, which you confirm or correct.
- **oracle**: how a case is checked. `label`: the answer must come out as that label. `fields`: its fields must match these values. `rubric`: a judge model grades it against a sentence.
- **scenario**: one situation that a group of cases covers.
- **review**: the pass in which you decide on each pending item.

What review will not change for you:
- A scenario's `id` and a case's `scenario`, because both name the file the cases live in (`.forge/cases/<scenario>.yaml`). The refusal names the `llm-tests-forge move` call that does it.

What editing can set off:
- Editing a scenario's `oracle` re-opens the approved cases of that scenario whose expected the new oracle no longer accepts. Each one then needs `edit` to be given an expected in the new shape, not `approve`.

Interrupting:
- One Ctrl+C saves what was decided so far.
- A second one before the save starts aborts without writing anything.
- One during the save lets it finish, then exits 130.
- Inside `$EDITOR`, Ctrl+C belongs to the editor. One that ignores it (Vim leaving insert mode) does neither of the above; one that Ctrl+C kills ends the pass and saves, as the first Ctrl+C does.

#### `move`

    llm-tests-forge move --scenario <old> <new>
    llm-tests-forge move --case <id> --to <scenario>

Renames a scenario or moves a case into another scenario, rewriting what the ids name: the scenario's cases file, every case id numbered from it, `duplicate_of` pointers, and `suite.include`.
- A moved case is numbered after the destination's last case.
- When the destination's oracle does not accept its expected, the case goes back to pending and the line says why.
- The destination is written before the source is touched, so a failure part-way leaves a duplicate to clean up, never a missing case.

At the end, `.forge/` holds `feature.yaml`, `scenarios.yaml` and `cases/<scenario>.yaml`: plain YAML, meant to be committed and diffed like any other test fixture.

### Running a suite

The remaining verbs turn that suite into a run. They read `.forge/suite.yaml`, which `describe` may have started for you and which you otherwise write by hand. It says what the suite runs against, which models judge a `rubric` case, and how many times each case repeats.

    # .forge/suite.yaml
    target:
      kind: python
      entry: forge_target.py          # optional: the shim, when not the default name
      python: .venv/bin/python        # an interpreter that can import your application
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # empty = every approved scenario

- `target.kind` is one of the nine kinds [below](#the-nine-target-kinds). `kind: promptfoo-python`, which older suites carry, still reads as `python`.
- The kind-specific keys are `target.python` (python), `target.command` (exec), and `target.url`, `target.method`, `target.headers`, `target.body` and `target.response` (http).

#### `estimate`

    llm-tests-forge estimate

Prices the run before you spend it. It makes no API call.

- **What it counts:** cases × target models × `repeat`, plus one judge call per `rubric` case per judge, target model and `repeat`.
- **Where prices come from:** `prices.yaml`, which is yours to edit. The output prints the date the file carries, and marks with `~` any model it had to price as its closest listed sibling.
- **Unknown providers:** a model whose provider has no row at all is not priced as anything. Its line reads `not priced`, and the total leaves it out and says how many lines it left out.
- **Tokens** are counted as characters ÷ 4. Every line and the total show a range around that point, `$low–$high (point $point)`, built from three pieces:
  - the input, re-counted at 3.5 to 4.2 characters per token;
  - the judge's prompt overhead and answer size, taken from recorded runs;
  - the target's output, at 0.5× to 1.25× of a size guessed from `output.kind` (or from the reviewed expected values), because nothing of the real answer's text exists before the run.
- **How far to trust it:** the bands were fit to the few runs committed with this repository, so read the range as a calibrated guess, not a budget.

#### `emit`

    llm-tests-forge emit

Writes `.forge/promptfooconfig.yaml` from the approved cases:
- one test per case, with its inputs as `vars`;
- a `javascript` assert for a `label` or `fields` oracle, and one `llm-rubric` per judge for a `rubric` one;
- a refusal, naming what, while anything is still pending.

On the first run it also writes the shim for your language, once and never overwritten again. **Fill in the function it names to call your application**: that is what makes the suite test your code rather than a copy of your prompt.

`--format jsonl` writes the same selection as `.forge/cases.jsonl` instead, for a runner of your own.

#### Run promptfoo

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

Promptfoo runs the suite from the suite directory (`bunx` works too). The forge does not run it for you. promptfoo exits with status 100 when any test fails: that is a result, not a crash.

#### `report`

    llm-tests-forge report results.json [--baseline .forge/report.json]

Reads promptfoo's output into `.forge/report.md` and `.forge/report.json`. They show:
- the pass rate and a per-scenario table;
- which reviewed scenarios had no case, no matched run, or were not in this suite;
- cases that passed on one repeat and failed on another;
- judges that disagreed, with both reasons;
- real cost against the estimate's range: within it, or how far above or below its nearer bound. A line that recorded no tokens says so instead of claiming a match.

With `--baseline`, an earlier `report.json` is compared:
- regressions are listed first;
- pairs the baseline has and this run does not (after a rename, say) are named rather than silently left out of the diff;
- a baseline written by an older version of the forge is accepted, keys it spelled differently included.

#### `stamp` and `check`

    llm-tests-forge stamp results.json
    llm-tests-forge check

A run only protects you if something notices when its inputs move.

**`stamp`** seals a passing run to the files you list in `suite.yaml` (`stamp.inputs`: the prompt file, a lockfile; `stamp.minimum_pass_rate`: the line), in `.forge/stamp.json`, which you commit. It refuses, writing nothing, while:
- any case fails on every repeat;
- the pass rate is under the line;
- an input is missing.

A case that failed on only some repeats is listed in the stamp and does not block it.

**`check`** is what CI runs: offline, no model call. It exits 1 naming:
- the input that changed, vanished or appeared;
- the target model or judge that differs from the sealed one;
- a line raised above the sealed pass rate.

It only warns when the forge or promptfoo version differs.

Sealing is a maintainer step after reading the report. The stamp proves that one run passed on those inputs, not that the feature works.

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

**What an `exec` command receives.** promptfoo runs it from `.forge/`, once per case and target model, with three arguments:
1. the rendered prompt (the feature's first input);
2. the provider options as JSON (the model is at `config.model`);
3. the context as JSON (the case's inputs are under `vars`, which also holds promptfoo's own keys starting with `__`, to ignore).

Standard input is empty. The answer goes to standard output and logs to standard error. A failure is a message on standard error and a non-zero exit status, which promptfoo shows as an error row.

**For `http`**, `emit` itself substitutes `{{target_model}}`, nested strings of `body` included, before the config is written. With more than one `target.models` and no `{{target_model}}` anywhere, every provider sends the same request, and `emit` prints a warning saying so.

**For every exec-style shim:**
- It answers on stdout, so your application must log to stderr.
- Compile the project (`mix compile`, `cargo build`, `go build`) before the first run. promptfoo runs cases concurrently, and a first compile racing itself is not verified safe.
- A shim that fails (a non-zero exit status, or an error it returns) shows as an error row in promptfoo, not as a failed assert.

### Agents

`init` adds a block to `AGENTS.md` that points an agent at `llm-tests-forge status` and `llm-tests-forge guide`. The rule in that manual is the important one: approving is the person's job, so an agent never marks anything approved by editing a file and never runs `review` for you.

A Claude Code skill (`plugin/skills/llm-tests-forge/`) is a thin pointer to the same manual. The install command is `/plugin marketplace add albertosca/llm-tests-forge`, and it works once the repository is public. Until then, `/plugin marketplace add <path to your clone>` installs it from a local checkout.

### What to commit under `.forge/`

Commit:
- `forge.yaml`;
- in each suite, `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, the shim and `report.md`/`report.json`.

They are the reviewed suite, the run it describes and the result, and their diffs are the point.

Gitignore `usage.jsonl` and `failures/`, which hold token counts and raw model output from your own runs.

Decide deliberately about `cases/imported.yaml`: `import` fills it with real production inputs, which may be data you cannot put in a repository.

### Exit codes

| Code | Means |
|---|---|
| `0` | the verb did what it says |
| `1` | the work failed: a file that is not there, a model that refused, a feature still pending review |
| `2` | the command line is unusable: an unknown verb or option, a bad flag value, a missing required argument, no model configured |

## Limitations

- It does not call promptfoo for you: `llm-tests-forge emit` writes the config and you run the eval yourself.
- promptfoo is the only emitter today.
- There is no MCP server, so the review loop cannot run inside a conversation.
- It tests one turn at a time. Multi-turn cases where your application's own reply shapes the next turn need a simulated user, which this is not.
- It keeps no history: `--baseline` compares two runs, and nothing collects them over time.
- It is not published to any package registry yet.

## Development

    bun test          # unit tests, no network, coverage gate
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, then typecheck, then test
    bun run test:live  # two real calls against google/gemini-3.5-flash by default (FORGE_LIVE=1); override with FORGE_DRAFTER
    bun run test:shims # runs every shim against its real toolchain and promptfoo (FORGE_SHIMS=1); slow, needs the toolchains
    bun run validate:example  # checks the committed example's promptfooconfig.yaml with the real promptfoo; no API key

`test:live` needs `GOOGLE_API_KEY` and fails loudly (not silently) if it is unset. Google's free tier is intermittent rather than simply down, so:
- a 503 or "high demand" response is retried, up to 3 attempts with a short pause between them;
- any other failure (quota, auth, an unknown model id, a schema mismatch) fails on the first occurrence.

The release targets live in `scripts/release/targets.ts`. Before you drop one, know that pip and RubyGems rank a newer version above a platform match: the next release's fallback wheel and gem would outrank the older platform package on that platform, so anyone who upgrades there gets the "no binary" message instead of the binary they had.

## Engineering decisions

**The forge writes config; promptfoo runs it.** Providers, concurrency, caching and the results viewer are promptfoo's. The forge owns what to test and what "correct" means, and its emitter sits in its own module, `src/emit`. `--format jsonl` hands the same selection to a runner of your own. The cost is one emitter today and a dependency on promptfoo's config format.

**Approval is a human act.** A drafted item is pending until a person decides on it in `review`. The agent manual says an agent never marks anything approved by editing a file and never runs `review`, and `emit` refuses to write while anything is pending.

**Expected outputs are plain files.** YAML under `.forge/`, one file of cases per scenario, so a change to what "correct" means is a diff someone has to read and approve.

**Estimates are ranges.** Nothing about the real answer exists before the run, so `estimate` reports a band around its point, calibrated on the few runs committed here: a guess, not a budget. A provider with no price row is left unpriced and counted as left out, never priced as something else. The arithmetic is under [`estimate`](#estimate).

**Sealing is offline.** `check` reads files and compares; it calls no model. It proves that one run passed on those inputs, not that the feature works.

**Writes fail safe.**
- `move` writes the destination before touching the source, so a failure part-way leaves a duplicate, not a missing case.
- The first Ctrl+C in a review saves what was decided; a second one before the save aborts without writing.
- The shim is written once and never overwritten.

**One binary, thin packages.**
- Every channel installs the same prebuilt binary. Its checksum is verified, and its provenance through a GitHub artifact attestation signed by the release workflow.
- A final release stops if the attestation fails. Only a prerelease tag (one holding a hyphen, such as `v0.2.0-rc.1`) in a private repository goes on with a warning, since GitHub Free, Pro and Team plans have attestations for public repositories only.
- The repository therefore has to be public, or on a plan with attestations for private ones, before the first final release.

**A strict gate.**
- Every file is held at 100% line and function coverage.
- The five modules (`core`, `cli`, `emit`, `report`, `llm`) are mutation-tested with the threshold at 100, so a surviving mutant is either killed or disabled with a stated reason.
- The committed example reports are regenerated from their raw results in CI, and the Ruby, Elixir and Python packages have their own linters.
- Bun measures no branch coverage, so a file at 100% can still hide untested guard arms: the gate is a floor, not proof that the suite is complete.

## Community

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, report vulnerabilities as [SECURITY.md](SECURITY.md) describes, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). What changed in each release is in the [changelog](CHANGELOG.md).

## License

MIT — see `LICENSE`.
