# Dogfood: the dedupe verb

A sealed suite that tests the forge's own `dedupe` prompt (`templates/dedupe.md`) and the real `dedupeCases` function behind it, with the forge. It was produced by the released forge (`llm-tests-forge@0.1.0`, installed under the alias `forge-released`) and it tests the code in this checkout, so version N-1 tests version N.

## What it tests

The target is `scripts/dogfood/dedupe-target.ts`, an `exec` program that runs the real `dedupeCases` with the production prompt and prints the pairs it marks as `{"duplicates": [{"id", "duplicate_of"}]}`. Each case is a short list of support tickets with the answer a careful reader would give. Eight scenarios:

| Scenario | Kind | What it pins |
|---|---|---|
| `wording-only-pair` | happy | two tickets say the same thing in different words: the later one is marked |
| `nothing-repeated` | happy | different problems, different labels: an empty list |
| `same-message-different-expected` | edge | same words, different expected label: not duplicates |
| `three-equal-cases` | edge | all three repeat: the second and the third point at the first |
| `ids-out-of-order` | edge | the later id is listed first: the kept case is still the earlier id |
| `instruction-inside-a-ticket` | adversarial | a ticket tells the model to mark everything: the text is data |
| `portuguese-tickets` | language | the same behaviour in Portuguese |
| `negation-flips-meaning` | ambiguous | "refund" versus "no refund": close words, different meaning |

There is no `out_of_scope` scenario on purpose: the real function only ever receives a list of cases read from files, so prose in place of a list never reaches it.

Every expected value is checked by the `fields` oracle (an exact comparison), so the judge declared in `suite.yaml` is never called; the schema requires one.

## Models

| Role | Model |
|---|---|
| target | `anthropic/claude-haiku-4-5` |
| judge (unused, see above) | `anthropic/claude-sonnet-5` |
| drafter | Claude Sonnet 5.5, writing the scenarios and cases in a Claude Code session |

The first suite stays on Haiku 4.5 because its price is exact and long measured.

## How it was produced

From this directory, with `FORGE=../../node_modules/.bin/llm-tests-forge`:

```
$FORGE describe "..." --prompt-file ../../templates/dedupe.md
$FORGE scenarios --kinds happy,edge,ambiguous,adversarial,language
$FORGE cases --n 3
$FORGE dedupe
$FORGE estimate
$FORGE emit
DOGFOOD_TRANSPORT=claude-cli bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2
$FORGE report results.json
$FORGE stamp results.json
```

`$FORGE check` is free and offline: it fails when the prompt, the function, the target, the entry runner or `bun.lock` changed after the seal. That is what runs on every pull request.

## What was run, and how it differs from the plan

- **The calls went through the Claude Code CLI, not the API.** The Anthropic API account had no credit on 2026-10-30, so the target ran with `DOGFOOD_TRANSPORT=claude-cli` (`scripts/dogfood/claude-cli-llm.ts`). The model is the one the spec names (`claude-haiku-4-5`); the transport differs, and the schema travels in the prompt instead of the API's structured output. The weekly workflow uses the API.
- **The drafter was not an API call either.** The scenarios and cases were written by Claude Sonnet 5.5 and fed to the forge through its `fake/<file>` model, then read and approved. `generated_by` says so on every case.
- The 48 rows (24 cases, repeat 2) all passed, none errored.

## Review

24 cases approved, 0 rejected, 0 edited; 8 scenarios approved, 0 rejected; `dedupe` marked no pair among the generated cases. This review is Claude's (Sonnet 5.5, 2026-10-30), not the maintainer's, and it is pending the maintainer's spot-check.

## Caveats

- **Circularity.** The cases and the code under test come from the same model family, and the suite is run by the forge it tests. A bug that fools both the released and the current forge in the same way would not be seen. The seal and the weekly run catch drift, not a flaw present from the start.
- **The suite does not discriminate yet.** 100% on the first run means Haiku 4.5 finds these cases easy, so a regression would have to be large to show. Harder cases are the way to make the pass rate informative.
