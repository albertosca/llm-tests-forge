# llm-tests-forge report — run 2026-09-30T16:27:10.834Z
Reported 2026-09-30T16:28:12.541Z.

**Pass rate:** 95.8% (46 of 48 runs, 0 errored) · **failing or errored:** 1 · **flaky:** 0 · **judge disagreements:** 0

## Failing or errored cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| empty-subject-and-minimal-body-03 | anthropic/claude-haiku-4-5 | 2 | 0 | 2 | 0 | The rubric requires both job_title and company to be null/empty, but while job_title is null, company is set to 'Harbor Oak Recruiting' rather than null or empty.; The output sets job_title to null, but company is set to 'Harbor Oak Recruiting' rather than null or empty, so it does not satisfy the rubric requirement that both fields be null/empty. |

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
| empty-subject-and-minimal-body | edge | 6 | 4 | 2 | 0 |
| automated-receipt-vs-actual-screening | ambiguous | 6 | 6 | 0 | 0 |
| fake-instructions-in-email-body | adversarial | 6 | 6 | 0 | 0 |
| email-about-unrelated-company-matter | out_of_scope | 6 | 6 | 0 | 0 |
| spanish-rejection-after-screening | language | 6 | 6 | 0 | 0 |

Coverage: 8 of 8 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-haiku-4-5 | target | 23606 | 4557 | $0.046391 | $0.036106–$0.062048 | within range |
| anthropic/claude-sonnet-5 | judge | 2296 | 602 | $0.010612 | $0.006862–$0.027964 | within range |

Target usage: reported by the shim.
