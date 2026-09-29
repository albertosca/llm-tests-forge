# llm-tests-forge: the manual for an agent operating it

## The rule

Above all, approving is the person's job. Never set `status: approved`, `edited` or `rejected` by editing a YAML file under `.forge/`, and never drive `llm-tests-forge review` on the person's behalf. When the pipeline reaches a review, stop and ask the person to run `llm-tests-forge review` (or `llm-tests-forge review --suite <path>`), then continue when they say it is done.

## Where things are

llm-tests-forge forges regression suites for LLM features: a person describes what a function does, the forge drafts scenarios and cases with a model, the person reviews every draft, and `emit` turns the approved cases into a promptfoo config. This manual is embedded in the installed binary, so it matches the installed version.

- `forge.yaml` at the project root lists the suites. Each suite is a directory with a `.forge/` inside it.
- `llm-tests-forge status` says what exists: one line per suite with its counts, last run and any version warning. `llm-tests-forge status --json` prints the same for a program.
- `--suite <path>` (path relative to the project root) runs a verb on a registered suite from anywhere inside the project; otherwise the verb uses the suite of the current directory.
- No `forge.yaml` yet: `llm-tests-forge init` detects the language, writes it, and adds a block about the forge to `AGENTS.md`.

## Starting a suite for a function

`cd` into a new directory (convention `evals/<function>/`), then run `llm-tests-forge describe "<what the function does>" --prompt-file <its system prompt>`. Then ask the person to review the feature.

## The pipeline

describe, review, scenarios, review, cases, review, dedupe (optional), emit, fill the shim, run promptfoo, report.

- These call the drafter and cost money: `describe`, `scenarios`, `cases`, `dedupe`.
- These cost nothing: `review`, `estimate`, `emit`, `report`.
- Run `llm-tests-forge estimate` before a real run: it prints tokens and dollars per model without calling any.

## Filling the shim

`emit` writes the file below once and never overwrites it. Fill in the one function named.

- **python:** `forge_target.py`, fill `run_application`. `target.python` in `suite.yaml` sets the interpreter promptfoo runs, which must be able to import the project's code.
- **javascript:** `forge_target.mjs`, fill `runApplication`.
- **typescript:** `forge_target.ts`, which promptfoo loads directly; fill `runApplication`.
- **elixir:** `forge_target.exs`, fill `run_application/2`. It runs through `mix run` from the mix project and needs Elixir 1.18 or newer for JSON. Run `mix compile` before the first run.
- **ruby:** `forge_target.rb`, fill `run_application`.
- **rust:** the `forge_target/` crate (`Cargo.toml` and `src/main.rs`). Uncomment the dependency on the project's crate, fill `run_application`, and build once with `cargo build --release` inside `forge_target/`.
- **go:** the `forge_target/` module (`go.mod` and `main.go`). Uncomment the `require` and `replace` lines, fill `runApplication`, and build once with `GOWORK=off go build -o forge_target .` inside `forge_target/`.
- **exec:** nothing is written. `suite.yaml` names the program in `target.command`.
- **http:** nothing is written. `suite.yaml` has `target.url`, and optionally `method`, `headers`, `body` (with `{{input}}`) and `response` (an expression over `json`, with no `=>`).

Every exec-style shim answers on stdout, so the application must log to stderr. Compile the project (`mix compile`, `cargo build`, `go build`) before the first run: promptfoo runs cases concurrently, and a first compile racing itself is not verified safe. A shim that fails (a non-zero exit status, or an error it returns) shows as an error row in promptfoo, not as a failed assert.

## Running

From the suite directory (needs Node):

`npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json`

then `llm-tests-forge report results.json`. promptfoo exits with status 100 when any test fails: that is a result, not a crash.

## Adding to an existing suite

`llm-tests-forge scenarios --more <n>` drafts more scenarios, `llm-tests-forge cases --scenario <id>` drafts cases for one scenario, and `llm-tests-forge import <file.jsonl>` brings in real inputs. Then ask the person to review.

## Every verb

- `llm-tests-forge init`: detect the language, write `forge.yaml` and the `AGENTS.md` block.
- `llm-tests-forge describe`: free text (or stdin) becomes `.forge/feature.yaml`, pending review. Calls the drafter.
- `llm-tests-forge scenarios`: the approved feature becomes `.forge/scenarios.yaml`. Calls the drafter.
- `llm-tests-forge cases`: approved scenarios become `.forge/cases/<id>.yaml`. Calls the drafter.
- `llm-tests-forge dedupe`: marks likely duplicate cases with `duplicate_of`. Calls the drafter.
- `llm-tests-forge import`: real inputs from a JSONL file become `.forge/cases/imported.yaml`.
- `llm-tests-forge review`: the person's approval loop. Never run it for them.
- `llm-tests-forge move`: rename a scenario, or move a case between scenarios, rewriting ids.
- `llm-tests-forge estimate`: tokens and dollars per model, with no call.
- `llm-tests-forge emit`: approved cases become `.forge/promptfooconfig.yaml` and the shim (or `--format jsonl` for `cases.jsonl`).
- `llm-tests-forge report`: promptfoo's `results.json` becomes `.forge/report.md` and `report.json`.
- `llm-tests-forge status`: every registered suite, with `--json` for agents.
- `llm-tests-forge guide`: print this manual.
- `llm-tests-forge help`: the usage summary; `llm-tests-forge version` prints the version.

## Keys and models

The drafter is `--drafter provider/model`, else `FORGE_DRAFTER`, else `defaults.drafter` in `forge.yaml`. Providers are anthropic, google, openai, ollama. Keys come from the environment (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`) first, and `~/.config/<provider>/api.env` is the fallback. Never print a key.
