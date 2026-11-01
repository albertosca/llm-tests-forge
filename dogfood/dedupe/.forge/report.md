# llm-tests-forge report — run 2026-11-01T17:59:07.874Z
Reported 2026-11-01T18:02:04.585Z.

**Pass rate:** 100.0% (58 of 58 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 0 · **regressions since baseline:** 0

## Regressions since baseline

No regression since baseline.

Fixed since baseline: 1.

Not in this run, so not compared: 1 baseline pair(s) — identifiers-differ-only-01 @ anthropic/claude-haiku-4-5.

## Failing or errored cases

No failing or errored case.

## Flaky cases

No flaky case.

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| wording-only-pair | happy | 6 | 6 | 0 | 0 |
| nothing-repeated | happy | 6 | 6 | 0 | 0 |
| same-message-different-expected | edge | 6 | 6 | 0 | 0 |
| three-equal-cases | edge | 6 | 6 | 0 | 0 |
| ids-out-of-order | edge | 6 | 6 | 0 | 0 |
| instruction-inside-a-ticket | adversarial | 6 | 6 | 0 | 0 |
| portuguese-tickets | language | 6 | 6 | 0 | 0 |
| negation-flips-meaning | ambiguous | 6 | 6 | 0 | 0 |
| two-groups-and-a-near-miss | edge | 4 | 4 | 0 | 0 |
| identifiers-differ-only | edge | 2 | 2 | 0 | 0 |
| near-miss-same-label | ambiguous | 4 | 4 | 0 | 0 |

Coverage: 11 of 11 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.021388–$0.033207 | no recorded tokens |

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
