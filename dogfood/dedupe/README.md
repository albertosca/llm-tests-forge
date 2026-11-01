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

`$FORGE check` is free and offline: it fails when the prompt, the function and what it imports, the target, the entry runner, the claude-cli client, `bun.lock` or the suite's own config and case files changed after the seal (the full list is in [`../README.md`](../README.md)). That is what runs on every pull request.

## What was run, and how it differs from the plan

- **The calls went through the Claude Code CLI, not the API.** The Anthropic API account had no credit on 2026-10-30, so the target ran with `DOGFOOD_TRANSPORT=claude-cli` (`scripts/dogfood/claude-cli-llm.ts`). The model is the one the spec names (`claude-haiku-4-5`); the transport differs, and the schema travels in the prompt instead of the API's structured output. The weekly workflow uses the API.
- **The drafter was not an API call either.** The scenarios and cases were written by Claude Sonnet 5.5 and fed to the forge through its `fake/<file>` model, then read and approved. `generated_by` says so on every case.
- The 24 cases of 2026-10-30 (48 rows) all passed, none errored.
- **Three harder scenarios (6 cases) were added on 2026-11-01, and the first run showed one real fault in the prompt and one fault in the suite.** The prompt fault: `near-miss-same-label-02`, "refund because it arrived late" and "refund because it arrived broken", same label, different situation, were marked as one, on both repeats. The expectation is right (the template says cases that differ in what makes them pass are not duplicates), so this was a weakness of the prompt.
- **Three attempts at the template, in order.** (1) Naming the late-versus-damaged example: the case was not fixed. (2) Asking whether one message could replace the other: the case still failed and another row went flaky, because the model stopped marking real duplicates. (3) Saying that the same expected answer is not enough, with a pair that stays apart and a pair that is a duplicate: `near-miss-same-label-02` is fixed. The third wording is the one in `templates/dedupe.md`.
- **The suite's fault: `identifiers-differ-only-01` failed because of the case, not the prompt.** Its tickets ("Order #4412 has not arrived yet", "Order #5523 arrived damaged", "Order #9981 has not arrived yet") sit in a YAML block that is parsed again, and an unquoted ` #` starts a YAML comment, so every message reached the model as just "Order" and marking them as duplicates was correct. This was found by reading the model's raw reply (its analysis said "User sends 'Order' message"), after the case had been wrongly set aside as a weakness of the prompt for a while. The messages are now quoted and the case is approved again; the other new cases were checked by parsing them and none lost text.
- **The sealed run is 60 of 60 rows (30 cases).** The run before the fix had one flaky row, `two-groups-and-a-near-miss-02`: in one of two repeats the model left out a real duplicate ("a charge I do not recognise" and "charged for something I did not buy"). It passed in the sealed run, so a weekly run can still fail on that row; the threshold is still to be calibrated.

## Review

30 cases approved, 0 rejected, 0 edited; 11 scenarios approved, 0 rejected; `dedupe` marked no pair among the first 24 generated cases. The 6 added cases were written by hand by Claude, not generated by the forge. This review is Claude's (Sonnet 5.5, 2026-10-30 and 2026-11-01), not the maintainer's, and it is pending the maintainer's spot-check.

## Caveats

- **Circularity.** The cases and the code under test come from the same model family, and the suite is run by the forge it tests. A bug that fools both the released and the current forge in the same way would not be seen. The seal and the weekly run catch drift, not a flaw present from the start.
- **The suite does not discriminate yet.** 100% on the first run means Haiku 4.5 finds these cases easy, so a regression would have to be large to show. Harder cases are the way to make the pass rate informative.
