# llm-tests-forge: the manual for an agent operating it

## The rule

Above all, approving is the person's job. Never set `status: approved`, `edited` or `rejected` by editing a YAML file under `.forge/`, and never drive `llm-tests-forge review` on the person's behalf. Also never:

- edit the content of an item that is already `approved` or `edited` (`expected`, `invariants`, a scenario's text) so that it stays approved without the person seeing the change;
- run `llm-tests-forge describe --force`, which replaces the person's reviewed feature and invariants: ask the person instead;
- run `llm-tests-forge review --all`, which approves in bulk (it is scoped to one scenario and needs `--scenario`, but it is still the person's call).

When the pipeline reaches a review, stop and ask the person to run `llm-tests-forge review` (or `llm-tests-forge review --suite <path>`), then continue when they say it is done.

## Where things are

llm-tests-forge forges regression suites for LLM features: a person describes what a function does, the forge drafts scenarios and cases with a model, the person reviews every draft, and `emit` turns the approved cases into a promptfoo config. This manual is embedded in the installed binary, so it matches the installed version.

Installed as a project dependency rather than on the PATH, the command is reached through the project's own tool: `npx llm-tests-forge` (npm), `uv run llm-tests-forge` (PyPI), `bundle exec llm-tests-forge` (RubyGems), and `_build/llm-tests-forge` under Elixir (placed there by `mix llm_tests_forge.install`). Every `llm-tests-forge` in this manual means that command.

- `forge.yaml` at the project root lists the suites. Each suite is a directory with a `.forge/` inside it. `describe` registers a new suite; a suite that already existed (copied in, or made before `init`) is registered by no verb: add its path to `suites:` in `forge.yaml` by hand (for example `suites: [evals/classify]`).
- `llm-tests-forge status` says what exists: one line per suite with its counts, last run and any version warning. `llm-tests-forge status --json` prints the same for a program.
- `--suite <path>` (path relative to the project root) runs a verb on a registered suite from anywhere inside the project; otherwise the verb uses the suite of the current directory.
- No `forge.yaml` yet: `llm-tests-forge init` detects the language, writes it, and adds a block about the forge to `AGENTS.md`.

## Reading status

A suite's line reads `<path>   <feature id>   <n> scenarios approved, <n> pending · <n> cases approved, <n> pending · last run <pass rate> (<date>)`, where approved includes edited. `(feature pending)` after the feature id means the feature waits for the person's review: `scenarios`, `cases`, `estimate`, `emit` and `report` refuse to run until it is approved. Rejected scenarios are left out of both counts and shown apart (`, <n> rejected`) when there are any. `missing` means the directory has no `.forge/`; `error: <message>` names the file that could not be read. The date is the day promptfoo ran (from `report.json`'s `ranAt`; for a report written before that field existed, the day the report was written), or `(unknown date)` when the value is not an ISO date (`--json` gives null for `date` then).

`--json` prints one document, `{ "suites": [...], "problems": [...] }`. Each entry of `suites` has `entry` and `state` (`ok`, `missing` or `error`); a `missing` suite has only those two, an `error` one adds `error` (the message), and an `ok` one adds `feature` (the feature id, or `(no feature yet)`), `featureStatus` (`pending`, `approved`, `edited`, or null with no `feature.yaml` yet), `scenarios` (`approved`, `pending`, `rejected`), `cases` (`approved`, `pending`), `lastRun` (`{ "passRate": 0..1, "date": "YYYY-MM-DD" or null when the date is unknown }`, or null before any report) and `warning` (a version warning, or null). Each entry of `problems` is a `forge.yaml` line that could not be used as a suite, with `entry` (the path as listed) and `reason` (why it was refused); the other suites still show in `suites`.

## Starting a suite for a function

`cd` into a new directory (convention `evals/<function>/`), then run `llm-tests-forge describe "<what the function does>" --prompt-file <its system prompt>`. Then ask the person to review the feature.

## The pipeline

describe, review, scenarios, review, cases, dedupe (optional), review, emit, fill the shim, run promptfoo, report. `dedupe` comes before the last review because it only touches pending cases (it skips approved and edited ones): it groups pending duplicates for the person to review.

- These call the drafter and cost money: `describe`, `scenarios`, `cases`, `dedupe`.
- These cost nothing: `review`, `estimate`, `emit`, `report`.
- Run `llm-tests-forge estimate` before a real run: it prints tokens and dollars per model without calling any.

## Filling the shim

`emit` writes the file below once and never overwrites it. Every shim lives in `.forge/<entry>` (the default names below; `target.entry` in `suite.yaml` renames it). Fill in the one function named.

- **python:** `forge_target.py`, fill `run_application`. `target.python` in `suite.yaml` sets the interpreter promptfoo runs, which must be able to import the project's code.
- **javascript:** `forge_target.mjs`, fill `runApplication`.
- **typescript:** `forge_target.ts`, which promptfoo loads directly; fill `runApplication`.
- **elixir:** `forge_target.exs`, fill `run_application/2`. It runs through `mix run` from the mix project and needs Elixir 1.18 or newer for JSON. Run `mix compile` before the first run.
- **ruby:** `forge_target.rb`, fill `run_application`.
- **rust:** the `forge_target/` crate (`Cargo.toml` and `src/main.rs`). Uncomment the dependency on the project's crate, fill `run_application`, and build once with `cargo build --release` inside `.forge/forge_target/`.
- **go:** the `forge_target/` module (`go.mod` and `main.go`). Uncomment the `require` and `replace` lines, fill `runApplication`, and build once with `GOWORK=off go build -o forge_target .` inside `.forge/forge_target/`.
- **exec:** nothing is written. `suite.yaml` names the program in `target.command`, which runs from `.forge/`, so a relative command is relative to `.forge/`. promptfoo runs it once per case and target model with three arguments: the rendered prompt (the feature's first input), the provider options as JSON (the model is at `config.model`), and the context as JSON (the case's inputs are under `vars`, which also holds promptfoo's own keys starting with `__`: ignore those). Standard input is empty. The answer goes to standard output and logs to standard error; a failure is a message on standard error and a non-zero exit status, which promptfoo shows as an error row.
- **http:** nothing is written. `suite.yaml` has `target.url`, and optionally `method`, `headers`, `body` (each of the feature's inputs is available as `{{<input name>}}`; the default body is one key per input) and `response` (an expression over `json`, with no `=>`). `emit` replaces `{{target_model}}` wherever it appears in `target.url`, a header value or `body` (nested strings included) with each provider's model; with more than one `target.models` and no `{{target_model}}`, every provider sends the same request, and `emit` prints a warning.

Every exec-style shim answers on stdout, so the application must log to stderr. Compile the project (`mix compile`, `cargo build`, `go build`) before the first run: promptfoo runs cases concurrently, and a first compile racing itself is not verified safe. A shim that fails (a non-zero exit status, or an error it returns) shows as an error row in promptfoo, not as a failed assert.

## Running

From the suite directory (needs Node):

`npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json`

then `llm-tests-forge report results.json`. promptfoo exits with status 100 when any test fails: that is a result, not a crash.

## Adding to an existing suite

`llm-tests-forge scenarios --more <n>` drafts more scenarios, `llm-tests-forge cases --scenario <id>` drafts cases for one scenario, and `llm-tests-forge import <file.jsonl>` brings in real inputs. Ask the person to review the new scenarios before running `cases`, which refuses a pending scenario; review the new cases before `emit`.

## Every verb

- `llm-tests-forge init`: detect the language, write `forge.yaml` and the `AGENTS.md` block.
- `llm-tests-forge describe`: free text (or stdin) becomes `.forge/feature.yaml`, pending review. Calls the drafter. Each input's name becomes a promptfoo template variable, so it takes ASCII letters, digits and underscores, starts with a letter (a leading underscore is promptfoo's own), and is none of `not`, `true`, `false`, `none`, `null` (`user_message`, not `user message`); a `feature.yaml` with any other name is refused. Renaming an input means renaming it in `feature.yaml`, in every case's `input:` keys and in the target or shim code; `estimate`, `emit` and `report` refuse an approved case whose input keys do not match the feature's inputs. `-h` and `--help` anywhere before a `--` print the usage, so a text that is one of them goes after `--`.
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
- `llm-tests-forge help`: the usage summary.
- `llm-tests-forge version`: print the installed version.

## Keys

`forge.yaml` (project root):

- `language`: the project's language.
- `suites`: the suite directories, relative to the project root. `describe` adds a new one; an existing suite is added by hand.
- `defaults.drafter`: the drafter model, as `provider/model`.
- `defaults.target_models`: the models the suites' application runs on.
- `defaults.judges`: the models that judge rubric asserts.

`.forge/suite.yaml` (one per suite):

- `target.kind`: one of python, javascript, typescript, elixir, ruby, rust, go, exec, http.
- `target.entry`: the shim's file or directory inside `.forge/`, when not the default.
- `target.models`: the models to run the application on.
- `judges`: the judge models.
- `repeat`: how many times each case runs.
- `include`: scenario ids to run; empty means every approved scenario.
- Kind-specific: `target.python` (interpreter, python), `target.command` (exec), `target.url`, `target.method`, `target.headers`, `target.body`, `target.response` (http), all described above.

How `suite.yaml` comes to exist: `describe` writes a starting `suite.yaml` when none exists yet, the project's language is not `other`, and both `defaults.target_models` and `defaults.judges` are set; otherwise the person writes it, and the error `emit` gives shows an example.

## Models and credentials

The drafter is `--drafter provider/model`, else `FORGE_DRAFTER`, else `defaults.drafter` in `forge.yaml`. Providers are anthropic, google, openai, ollama. Keys come from the environment (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`) first, and `~/.config/<provider>/api.env` is the fallback. That fallback file is read by the forge only: promptfoo, which calls the rubric judges, sees only the keys in its environment, so a judge's key must be exported before running promptfoo. Never print a key.
