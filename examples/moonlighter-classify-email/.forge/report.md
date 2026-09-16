# forge report — 2026-09-16T01:48:20.374Z

**Pass rate:** 93.8% (45 of 48 runs, 0 errored) · **failing:** 1 · **flaky:** 1 · **judge disagreements:** 0

## Failing cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| empty-subject-and-minimal-body-03 | anthropic/claude-haiku-4-5 | 2 | 0 | 2 | 0 | The rubric requires both job_title and company to be null/empty when no identifying details are present. While job_title is null, company is set to 'Harbor Oak Recruiting' rather than null or empty, so the output does not fully satisfy the rubric.; The rubric requires both job_title and company to be null/empty when the email provides no identifying details. While job_title is null, company is set to 'Harbor Oak Recruiting', which is not null or empty. This violates the rubric's requirement. |

## Flaky cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| empty-subject-and-minimal-body-02 | anthropic/claude-haiku-4-5 | 2 | 1 | 1 | 0 | The output classified the email as 'screening', which the rubric explicitly says should be avoided in favor of labels like 'unrelated' or 'acknowledgement' when no concrete hiring action or stage is mentioned. |

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| standard-interview-request-email | happy | 6 | 6 | 0 | 0 |
| formal-job-offer-letter | happy | 6 | 6 | 0 | 0 |
| rejection-after-interview | happy | 6 | 6 | 0 | 0 |
| empty-subject-and-minimal-body | edge | 6 | 3 | 3 | 0 |
| automated-receipt-vs-actual-screening | ambiguous | 6 | 6 | 0 | 0 |
| fake-instructions-in-email-body | adversarial | 6 | 6 | 0 | 0 |
| email-about-unrelated-company-matter | out_of_scope | 6 | 6 | 0 | 0 |
| spanish-rejection-after-screening | language | 6 | 6 | 0 | 0 |

Coverage: 8 of 8 approved scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 0 | 0 | — | $0.051836 | — |
| anthropic/claude-sonnet-5 | judge | 2295 | 1042 | $0.015010 | $0.009168 | +63.7% |

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
