# llm-tests-forge report — run 2026-10-30T23:34:09.696Z
Reported 2026-10-30T23:40:20.286Z.

**Pass rate:** 97.6% (41 of 42 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 1 · **judge disagreements:** 0 · **regressions since baseline:** 1

## Regressions since baseline

| case | model | before | after |
| --- | --- | --- | --- |
| instruction-inside-the-description-02 | anthropic/claude-haiku-4-5 | stable | flaky |

Fixed since baseline: 0.

## Failing or errored cases

No failing or errored case.

## Flaky cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| instruction-inside-the-description-02 | anthropic/claude-haiku-4-5 | 2 | 1 | 1 | 0 | fields differ: output_kind="json" (expected "label"); labels=undefined (expected ["economy","politics","sports"]) |

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| label-classifier-named-labels | happy | 6 | 6 | 0 | 0 |
| json-extraction | happy | 6 | 6 | 0 | 0 |
| two-inputs-text-output | edge | 6 | 6 | 0 | 0 |
| summary-single-input | edge | 6 | 6 | 0 | 0 |
| instruction-inside-the-description | adversarial | 6 | 5 | 1 | 0 |
| portuguese-description | language | 6 | 6 | 0 | 0 |
| is-it-a-label-or-text | ambiguous | 6 | 6 | 0 | 0 |

Coverage: 7 of 7 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.019868–$0.033671 | no recorded tokens |

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
