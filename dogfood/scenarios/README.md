# Dogfood: the scenarios verb

A sealed suite that tests the forge's own `scenarios` prompt (`templates/scenarios.md`) and the real `enumerateScenarios` function behind it, with the forge. It was produced by the released forge (`llm-tests-forge@0.1.0`, installed under the alias `forge-released`) and it tests the code in this checkout, so version N-1 tests version N.

## What it tests

The target is `scripts/dogfood/scenarios-target.ts`, an `exec` program that runs the real `enumerateScenarios` on a feature (YAML) and the comma-separated `kinds` it must cover, and prints `{"covered": [...]}`, the wanted kinds sorted. The function throws when the model leaves a wanted kind out, so a row passes only if every wanted kind came back; a throw is an error row.

| Scenario | Kind | What it pins |
|---|---|---|
| `all-six-kinds-label-feature` | happy | A classifier feature with all six kinds wanted: the scenarios cover all six kinds. |
| `two-kinds-only` | edge | Only happy and edge are wanted: both are covered. |
| `single-kind-json-feature` | edge | A JSON extraction feature with one wanted kind, adversarial: the adversarial kind is covered. |
| `instruction-inside-the-feature` | adversarial | The feature's purpose tells the tool to ignore the wanted kinds; the text is data, so the wanted kinds are covered. |
| `portuguese-feature` | language | A feature written in Portuguese with happy and language wanted: the kinds come out as asked. |
| `text-feature-out-of-scope` | ambiguous | A free-text summariser with ambiguous and out_of_scope wanted: both kinds appear. |

There is no `out_of_scope` scenario on purpose: the real function is not given prose it should refuse. Six scenarios, three cases each, repeat 2.

## Weaker than a rubric check

A rubric judge would need Anthropic API credit, which the account did not have, and the claude-cli transport cannot serve it. So the target prints a deterministic structural summary of what the real function returned, and the `fields` oracle compares it exactly. The judge is declared in `suite.yaml` because the schema requires one, and it is never called. These suites show that the function still returns the right shape and the right choices on these inputs; they do not judge the quality of the generated text.

The one value the target prints, `covered`, is read from what the function returned, but the function already refuses an answer that misses a wanted kind, so in practice the signal of this suite is whether the call threw (an error row), not a wrong value. Only the presence of wanted kinds is checked: the prompt asks for "at least one of each", and nothing in the function or the prompt restricts the proposal to them.

## Models

| Role | Model |
|---|---|
| target | `anthropic/claude-haiku-4-5` |
| judge (unused, see above) | `anthropic/claude-sonnet-5` |
| drafter | Claude Sonnet 5.5, writing the scenarios and cases in a Claude Code session |

## How it was produced

From this directory, with `FORGE=../../node_modules/.bin/llm-tests-forge`: `$FORGE describe "..." --prompt-file ../../templates/scenarios.md`, `$FORGE scenarios --kinds <kinds>`, `$FORGE cases --n 3`, `$FORGE estimate`, `$FORGE emit`, then `DOGFOOD_TRANSPORT=claude-cli bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2`, `$FORGE report results.json` and `$FORGE stamp results.json`. `$FORGE check` is free and offline: it fails when the prompt, the function, the target, the shared input parser, the entry runner or `bun.lock` changed after the seal.

## What was run, and how it differs from the plan

- **The calls went through the Claude Code CLI, not the API.** The Anthropic API account had no credit on 2026-10-30, so the target ran with `DOGFOOD_TRANSPORT=claude-cli` (`scripts/dogfood/claude-cli-llm.ts`). The model is the one the spec names (`claude-haiku-4-5`); the transport differs. The weekly workflow uses the API.
- **The drafter was not an API call either.** The scenarios and cases were written by Claude Sonnet 5.5 and fed to the forge through its `fake/<file>` model, then read and approved. `generated_by` says so on every case.
- **The first run failed 26 of 36 rows, and the fault was the suite's.** The first cases asserted that no unwanted kind appears. Haiku 4.5 returned all six kinds every time, because the prompt lists all six and asks for "at least one of each wanted kind", never "only these". The expectation was wrong, not the model, so the target and the cases were changed to the contract the function actually has (`covered`), and the suite was rebuilt and rerun from scratch. Worth a decision by the maintainer: `--kinds` is a floor, not a filter, and its usage line does not say so.
- The 36 rows of the rebuilt suite (18 cases, repeat 2) all passed, none errored.

## Review

18 cases approved, 0 rejected, 0 edited; 6 scenarios approved, 0 rejected. This review is Claude's (Sonnet 5.5, 2026-10-30), not the maintainer's, and it is pending the maintainer's spot-check.

## Caveats

- **Circularity.** The cases and the code under test come from the same model family, and the suite is run by the forge it tests. A bug that fools both the released and the current forge in the same way would not be seen. The seal and the weekly run catch drift, not a flaw present from the start.
- **A 100% first run is weak evidence.** It means Haiku 4.5 finds these cases easy, so a regression would have to be large to show. Harder cases are the way to make the pass rate informative.
