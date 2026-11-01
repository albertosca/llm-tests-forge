# llm-tests-forge report — run 2026-11-01T17:17:18.593Z
Reported 2026-11-01T17:32:42.411Z.

**Pass rate:** 100.0% (42 of 42 runs, 0 errored) · **failing or errored:** 0 · **flaky:** 0 · **judge disagreements:** 0 · **regressions since baseline:** 0

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
| all-six-kinds-label-feature | happy | 6 | 6 | 0 | 0 |
| two-kinds-only | edge | 6 | 6 | 0 | 0 |
| single-kind-json-feature | edge | 6 | 6 | 0 | 0 |
| instruction-inside-the-feature | adversarial | 6 | 6 | 0 | 0 |
| portuguese-feature | language | 6 | 6 | 0 | 0 |
| text-feature-out-of-scope | ambiguous | 6 | 6 | 0 | 0 |
| all-six-kinds-json-feature | edge | 2 | 2 | 0 | 0 |
| rare-kind-on-a-narrow-feature | ambiguous | 4 | 4 | 0 | 0 |

Coverage: 8 of 8 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.021038–$0.030706 | no recorded tokens |

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
