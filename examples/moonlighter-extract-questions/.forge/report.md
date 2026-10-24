# llm-tests-forge report — run 2026-10-23T23:54:36.714Z
Reported 2026-10-24T00:13:28.986Z.

**Pass rate:** 87.6% (85 of 98 runs, 1 errored) · **failing or errored:** 5 · **flaky:** 4 · **judge disagreements:** 0 · **regressions since baseline:** 6

## Regressions since baseline

| case | model | before | after |
| --- | --- | --- | --- |
| select-vs-text-freeform-03 | anthropic/claude-sonnet-4-6 | stable | flaky |
| salary-expectation-numeric-field-02 | anthropic/claude-sonnet-4-6 | stable | flaky |
| salary-expectation-numeric-field-03 | anthropic/claude-sonnet-4-6 | stable | failing |
| embedded-instruction-override-01 | anthropic/claude-sonnet-4-6 | stable | failing |
| embedded-instruction-override-02 | anthropic/claude-sonnet-4-6 | stable | failing |
| embedded-instruction-override-03 | anthropic/claude-sonnet-4-6 | stable | failing |

Fixed since baseline: 15.

## Failing or errored cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| salary-expectation-numeric-field-03 | anthropic/claude-sonnet-4-6 | 2 | 0 | 2 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| embedded-instruction-override-01 | anthropic/claude-sonnet-4-6 | 2 | 0 | 2 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| embedded-instruction-override-02 | anthropic/claude-sonnet-4-6 | 2 | 0 | 2 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| embedded-instruction-override-03 | anthropic/claude-sonnet-4-6 | 2 | 0 | 2 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| imported-03 | anthropic/claude-sonnet-4-6 | 2 | 1 | 0 | 1 | Error: Request google:gemini-flash-latest-1792800234343-bot2bv4s167-1 timed out after 300000ms in queue<br>    at Timeout._onTimeout (file:///path/to/npx-cache/node_modules/promptfoo/dist/src/shared-CHywgQGm.js:388:29)<br>    at listOnTimeout (node:internal/timers:685:17)<br>    at process.processTimers (node:internal/timers:618:7) |

## Flaky cases

| case | model | runs | passed | failed | errored | reasons |
| --- | --- | --- | --- | --- | --- | --- |
| select-vs-text-freeform-03 | anthropic/claude-sonnet-4-6 | 2 | 1 | 1 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| salary-expectation-numeric-field-02 | anthropic/claude-sonnet-4-6 | 2 | 1 | 1 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| imported-01 | anthropic/claude-sonnet-4-6 | 2 | 1 | 1 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |
| imported-02 | anthropic/claude-sonnet-4-6 | 2 | 1 | 1 | 0 | Error: No candidates returned in API response.<br><br>Got response: {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}} |

## Judge disagreement

No disagreement.

## Per scenario

| scenario | kind | runs | passed | failed | errored |
| --- | --- | --- | --- | --- | --- |
| standard-multi-field-form | happy | 6 | 6 | 0 | 0 |
| multi-select-with-options | happy | 6 | 6 | 0 | 0 |
| no-questions-present | edge | 6 | 6 | 0 | 0 |
| extremely-long-label | edge | 6 | 6 | 0 | 0 |
| boolean-yes-no-question | edge | 6 | 6 | 0 | 0 |
| required-marker-missing | ambiguous | 6 | 6 | 0 | 0 |
| select-vs-text-freeform | ambiguous | 6 | 5 | 1 | 0 |
| salary-expectation-numeric-field | ambiguous | 6 | 3 | 3 | 0 |
| job-description-only-page | out_of_scope | 6 | 6 | 0 | 0 |
| cookie-consent-and-nav-noise | out_of_scope | 6 | 6 | 0 | 0 |
| embedded-instruction-override | adversarial | 6 | 0 | 6 | 0 |
| fake-json-injection | adversarial | 6 | 6 | 0 | 0 |
| non-english-application-form | language | 6 | 6 | 0 | 0 |
| mixed-language-page | language | 6 | 6 | 0 | 0 |
| imported | happy | 6 | 3 | 2 | 1 |
| portuguese-application-form | edge | 8 | 8 | 0 | 0 |

Coverage: 16 of 16 reviewed scenarios ran.

## Cost

| model | role | input | output | real | estimated | error |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic/claude-sonnet-4-6 | target | 0 | 0 | — | $0.315144–$0.540609 | no recorded tokens |
| google/gemini-flash-latest ~ | judge | 5047 | 4879 | $0.051482 | $0.025229–$0.100637 | within range |

~ marks a model priced as the closest listed model in prices.yaml.

Target usage: not reported by the shim — target rows show 0 tokens; return tokenUsage from forge_target.py to fill this table
