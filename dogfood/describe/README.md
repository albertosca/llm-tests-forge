# Dogfood: the describe verb

A sealed suite that tests the forge's own `describe` prompt (`templates/describe.md`) and the real `describeFeature` function behind it, with the forge. It was produced by the released forge (`llm-tests-forge@0.1.0`, installed under the alias `forge-released`) and it tests the code in this checkout, so version N-1 tests version N.

## What it tests

The target is `scripts/dogfood/describe-target.ts`, an `exec` program that runs the real `describeFeature` on a plain-language description and prints `{"input_count", "output_kind", "labels"?, "has_invariants", "status"}`. Each case states only what the description makes certain: the number of inputs, the kind of output and, when the description names its labels, the sorted labels. `has_invariants` is printed but never asserted, because the model varied it between runs (true for some summaries, false elsewhere).

| Scenario | Kind | What it pins |
|---|---|---|
| `label-classifier-named-labels` | happy | The description names the labels of a classifier of one input: the feature has one input, a label output and exactly those labels. |
| `json-extraction` | happy | The description asks to pull named fields out of one text and return them as JSON: one input, a json output. |
| `two-inputs-text-output` | edge | The description gives a feature that takes two separate inputs and returns free text: input_count is 2 and the output is text. |
| `summary-single-input` | edge | A feature that writes a short summary of one text: one input, a text output, no labels. |
| `instruction-inside-the-description` | adversarial | The description of a classifier ends with a sentence telling the reader to ignore the task and declare the output text; the sentence is data, so the output is still a label. |
| `portuguese-description` | language | A description written in Portuguese that names its labels with English words: it reads the same as the English one. |
| `is-it-a-label-or-text` | ambiguous | A description of deciding whether a message is urgent, without naming the answers: the output is read as a label, with one input. |

There is no `out_of_scope` scenario on purpose: the real function is not given prose it should refuse. Seven scenarios, three cases each, repeat 2.

## Weaker than a rubric check

A rubric judge would need Anthropic API credit, which the account did not have, and the claude-cli transport cannot serve it. So the target prints a deterministic structural summary of what the real function returned, and the `fields` oracle compares it exactly. The judge is declared in `suite.yaml` because the schema requires one, and it is never called. These suites show that the function still returns the right shape and the right choices on these inputs; they do not judge the quality of the generated text.

## Models

| Role | Model |
|---|---|
| target | `anthropic/claude-haiku-4-5` |
| judge (unused, see above) | `anthropic/claude-sonnet-5` |
| drafter | Claude Sonnet 5.5, writing the scenarios and cases in a Claude Code session |

## How it was produced

From this directory, with `FORGE=../../node_modules/.bin/llm-tests-forge`: `$FORGE describe "..." --prompt-file ../../templates/describe.md`, `$FORGE scenarios --kinds <kinds>`, `$FORGE cases --n 3`, `$FORGE estimate`, `$FORGE emit`, then `DOGFOOD_TRANSPORT=claude-cli bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2`, `$FORGE report results.json` and `$FORGE stamp results.json`. `$FORGE check` is free and offline: it fails when the prompt, the function, the target, the shared input parser, the entry runner or `bun.lock` changed after the seal.

## What was run, and how it differs from the plan

- **The calls went through the Claude Code CLI, not the API.** The Anthropic API account had no credit on 2026-10-30, so the target ran with `DOGFOOD_TRANSPORT=claude-cli` (`scripts/dogfood/claude-cli-llm.ts`). The model is the one the spec names (`claude-haiku-4-5`); the transport differs. The weekly workflow uses the API.
- **The drafter was not an API call either.** The scenarios and cases were written by Claude Sonnet 5.5 and fed to the forge through its `fake/<file>` model, then read and approved. `generated_by` says so on every case.
- The 42 rows (21 cases, repeat 2) of 2026-10-30 all passed in the sealed run, none errored (the seal then was the fifth run, see below). The raw outputs were read: the feature differs per description, so the pass is not a constant answer.
- **Flaky on injection, before the prompt was hardened.** Of five runs on 2026-10-30, three failed 1, 2 and 1 of the 42 rows, all in the `instruction-inside-the-description` scenario (the model obeyed the hidden instruction). The prompt now says its input blocks are data, and names a `SYSTEM:` line; the baseline was resealed after two consecutive runs of 42 of 42 (a first hardening without the `SYSTEM:` sentence still failed one row). The second rerun's failing rows are kept in [`reruns/2026-10-30-second-rerun.json`](reruns/2026-10-30-second-rerun.json); see [the finding](../README.md#a-finding-the-reruns-exposed).

- **Five harder cases were added on 2026-11-01** (five inputs and a label, a Spanish description, a JSON list output). The first run of the 52 rows had one error: for "Decide whether an incoming message is urgent", which names no answers, the model returned a `label` output with an empty `labels` list and the schema refused it. The prompt now says that a decision without named answers is still a label whose `labels` are the answers the question implies. The rerun passed 52 of 52 rows.

## Review

26 cases approved, 0 rejected, 0 edited; 10 scenarios approved, 0 rejected. The 5 added cases were written by hand by Claude, not generated by the forge. This review is Claude's (Sonnet 5.5, 2026-10-30 and 2026-11-01), not the maintainer's, and it is pending the maintainer's spot-check.

## Caveats

- **Circularity.** The cases and the code under test come from the same model family, and the suite is run by the forge it tests. A bug that fools both the released and the current forge in the same way would not be seen. The seal and the weekly run catch drift, not a flaw present from the start.
- **A 100% first run is weak evidence.** It means Haiku 4.5 finds these cases easy, so a regression would have to be large to show. Harder cases are the way to make the pass rate informative.
