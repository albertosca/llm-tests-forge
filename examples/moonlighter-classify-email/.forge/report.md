# forge report — 2026-09-16T13:42:44.333Z

**Pass rate:** 95.8% (46 of 48 runs, 0 errored) · **failing or errored:** 1 · **flaky:** 0 · **judge disagreements:** 0

## Failing or errored cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| empty-subject-and-minimal-body-03 | anthropic/claude-haiku-4-5 | 2 | 0 | 2 | 0 | The rubric requires both job_title and company to be null or empty, but the output sets company to 'Harbor Oak Recruiting' instead of null, so it fails the requirement.; The rubric requires both job_title and company to be null/empty, but while job_title is null, company is set to 'Harbor Oak Recruiting' rather than null or empty. |

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
| anthropic/claude-haiku-4-5 | target | 23588 | 4526 | $0.046218 | $0.051836 | -10.8% |
| anthropic/claude-sonnet-5 | judge | 2305 | 666 | $0.011270 | $0.014808 | -23.9% |

Target usage: reported by the shim.
