# forge report — 2026-09-16T00:53:16.050Z

**Pass rate:** 100.0% (48 of 48 runs) · **flaky:** 0 · **judge disagreements:** 0

## Flaky cases

No flaky case.

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| standard-interview-request-email | happy | 6 | 6 | 0 | 0 |
| formal-job-offer-letter | happy | 6 | 6 | 0 | 0 |
| rejection-after-interview | happy | 6 | 6 | 0 | 0 |
| empty-subject-and-minimal-body | edge | 6 | 6 | 0 | 0 |
| automated-receipt-vs-actual-screening | ambiguous | 6 | 6 | 0 | 0 |
| fake-instructions-in-email-body | adversarial | 6 | 6 | 0 | 0 |
| email-about-unrelated-company-matter | out_of_scope | 6 | 6 | 0 | 0 |
| spanish-rejection-after-screening | language | 6 | 6 | 0 | 0 |

Coverage: 8 of 8 approved scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | $0.000000 | $0.051836 | -100.0% |
| anthropic/claude-sonnet-5 | judge | 2198 | 473 | $0.009126 | $0.009168 | -0.5% |

Target usage: not reported by the shim: target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
