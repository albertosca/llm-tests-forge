# llm-tests-forge report — run 2026-11-01T17:36:19.993Z
Reported 2026-11-01T17:42:48.806Z.

**Pass rate:** 100.0% (52 of 52 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 0 · **regressions since baseline:** 0

## Regressions since baseline

No regression since baseline.

Fixed since baseline: 0.

## Failing or errored cases

No failing or errored case.

## Flaky cases

No flaky case.

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| label-classifier-named-labels | happy | 6 | 6 | 0 | 0 |
| json-extraction | happy | 6 | 6 | 0 | 0 |
| two-inputs-text-output | edge | 6 | 6 | 0 | 0 |
| summary-single-input | edge | 6 | 6 | 0 | 0 |
| instruction-inside-the-description | adversarial | 6 | 6 | 0 | 0 |
| portuguese-description | language | 6 | 6 | 0 | 0 |
| is-it-a-label-or-text | ambiguous | 6 | 6 | 0 | 0 |
| many-inputs-label | edge | 4 | 4 | 0 | 0 |
| spanish-description | language | 4 | 4 | 0 | 0 |
| json-list-output | edge | 2 | 2 | 0 | 0 |

Coverage: 10 of 10 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.035049–$0.054228 | no recorded tokens |

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
