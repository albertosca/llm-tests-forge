# Building a suite

The whole flow, in order. Each step has its own entry below.

1. `init` once per project.
2. `describe`, then `review`: the forge writes a description of the feature, and you approve it.
3. `scenarios`, then `review --only scenarios`: situations the feature must handle, approved by you.
4. `cases`, then `dedupe`, optionally `import`, then `review`: the cases and their expected outputs, approved by you.
5. `estimate`, then `emit`: the price, then the promptfoo config.
6. Run promptfoo yourself, then `report`.
7. Optionally `stamp` after a good run, and `check` in CI.

## Setting up a project

Run these from inside the project whose LLM feature you are testing.

### `init`

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

### `status`

    llm-tests-forge status

One line per registered suite, showing:
- its feature, marked `(feature pending)` while it waits for review;
- its scenarios and cases as approved and pending (rejected scenarios are shown apart, never in those counts);
- its last run and any version warning.

`status --json` prints the same for a program, with `featureStatus` and `scenarios: { approved, pending, rejected }`. It is how a person, or an agent with no chat history, finds out what exists and what is pending.

### `guide`

    llm-tests-forge guide

Prints the manual for an agent operating the forge. It is embedded in the installed binary, so it always matches the installed version.

### Choosing the suite

- `--suite <path>` (a path relative to the project root) runs any verb on a registered suite from anywhere inside the project.
- Without it, a verb uses the suite of the current directory.
- A directory with `.forge/` and no `forge.yaml` above it still works as a stand-alone suite.

## The drafter

The drafter is the model that writes the feature, scenarios and cases. Everything it writes arrives pending.

Set it with, in this order of precedence: `--drafter provider/model`, else `FORGE_DRAFTER`, else `defaults.drafter` in `forge.yaml`. Keys come from the environment first, and `~/.config/<provider>/api.env` is the fallback.

| Provider | Env var | Example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | none (local) | `ollama/llama3` |
| `fake` | none | `fake/path/to/responses.json`, for tests |

## Building a suite

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

### `describe`

    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Writes `.forge/feature.yaml` as a pending, structured description of the feature: purpose, inputs, output shape, invariants.

- **Input names** become promptfoo template variables. They take ASCII letters, digits and underscores, start with a letter (a leading underscore is promptfoo's own), and are none of `not`, `true`, `false`, `none`, `null`. Write `user_message`, not `user message`. A `feature.yaml` with any other name is refused.
- **Renaming an input** means renaming it in `feature.yaml`, in every case's `input:` keys and in the target or shim code. Until then, `estimate`, `emit` and `report` refuse an approved case whose input keys do not match the feature's inputs.
- **`--prompt-file`** is optional. Pass it when the function has a real system prompt worth copying rules from. The path is relative to where you run the command, hence `../../` from `evals/classify_response`.
- **Running it again** over a feature you have already reviewed is refused, because it would overwrite the invariants you wrote by hand. Pass `--force` when replacing it is what you want.
- **It also writes a starting `suite.yaml`** when all three hold: no `suite.yaml` exists yet, the project's language is not `other`, and `forge.yaml` sets both `defaults.target_models` and `defaults.judges`.

### `scenarios`

    llm-tests-forge scenarios

Generates `.forge/scenarios.yaml`: a set of scenarios covering all six kinds for the approved feature. `--more <n>` drafts more later.

### `cases`

    llm-tests-forge cases --n 5

Generates 5 pending cases per approved scenario in `.forge/cases/<scenario-id>.yaml`. Each has an expected output computed from the feature's oracle shape (`label`, `fields` or `rubric`). `--scenario <id>` drafts cases for one scenario only.

### `dedupe`

    llm-tests-forge dedupe

Flags likely-duplicate cases within each scenario (`duplicate_of`) without removing them. It only touches pending cases, so it comes before the review of the cases.

### `import`

    llm-tests-forge import ../../logs/real-inputs.jsonl

Reads one `{"input-name": "value"}` JSON object per line from real production logs and adds them as pending cases in the `imported` scenario. They have no expected output: you supply it during review.

### `review`

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

### `move`

    llm-tests-forge move --scenario <old> <new>
    llm-tests-forge move --case <id> --to <scenario>

Renames a scenario or moves a case into another scenario, rewriting what the ids name: the scenario's cases file, every case id numbered from it, `duplicate_of` pointers, and `suite.include`.
- A moved case is numbered after the destination's last case.
- When the destination's oracle does not accept its expected, the case goes back to pending and the line says why.
- The destination is written before the source is touched, so a failure part-way leaves a duplicate to clean up, never a missing case.

At the end, `.forge/` holds `feature.yaml`, `scenarios.yaml` and `cases/<scenario>.yaml`: plain YAML, meant to be committed and diffed like any other test fixture.
