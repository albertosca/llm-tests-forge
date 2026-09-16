# forge report — 2026-09-16T01:11:17.596Z

**Pass rate:** 93.8% (45 of 48 runs) · **flaky:** 1 · **judge disagreements:** 0

## Flaky cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| empty-subject-and-minimal-body-02 | anthropic/claude-haiku-4-5 | 2 | 1 | 0 | 1 | The output classified the email as 'screening', which the rubric explicitly says should be avoided in favor of labels like 'unrelated' or 'acknowledgement' when no concrete hiring action or stage is mentioned. |

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| standard-interview-request-email | happy | 6 | 6 | 0 | 0 |
| formal-job-offer-letter | happy | 6 | 6 | 0 | 0 |
| rejection-after-interview | happy | 6 | 6 | 0 | 0 |
| empty-subject-and-minimal-body | edge | 6 | 3 | 0 | 3 |
| automated-receipt-vs-actual-screening | ambiguous | 6 | 6 | 0 | 0 |
| fake-instructions-in-email-body | adversarial | 6 | 6 | 0 | 0 |
| email-about-unrelated-company-matter | out_of_scope | 6 | 6 | 0 | 0 |
| spanish-rejection-after-screening | language | 6 | 6 | 0 | 0 |

Coverage: 8 of 8 approved scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | $0.000000 | $0.051836 | -100.0% |
| anthropic/claude-sonnet-5 | judge | 2295 | 1042 | $0.015010 | $0.009168 | +63.7% |

Target usage: not reported by the shim: target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
