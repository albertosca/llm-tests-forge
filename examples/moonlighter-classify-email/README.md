# Example: classifying hiring-process email with moonlighter

The target is [moonlighter](https://github.com/albertosca/moonlighter), a job-application tracker. Its `classify_response` (`packages/email/moonlighter/tracking/classification.py`) takes one email a candidate received and returns a JSON object with `type`, `stage`, `new_stage`, `company`, `job_title` and `summary`, where `type` is one of seven labels. The rule this suite exists to protect is the one that is easiest to get wrong: an automated "we have received your application" is `acknowledgement`, never `screening` and never `interview` — the process has not started. `prompt.txt` in this directory is that function's prompt, copied verbatim, with the untrusted-email block and the stage list replaced by placeholders.

Everything under `.forge/` here was produced by `forge` and reviewed by hand, then run once against the real application. `results.json` and `.forge/report.*` are the output of that single run, dated in `report.json` (`generatedAt: 2026-09-16T00:53:16.050Z`, promptfoo 0.123.0) — they are a record of one run on one day, not something regenerated on every commit.

## Models used, and why Google is absent

| role | model |
| --- | --- |
| `describe` | `google/gemini-3.6-flash` |
| `scenarios` | `anthropic/claude-haiku-4-5` |
| `cases`, `dedupe` | `anthropic/claude-sonnet-5` |
| target under test (`suite.yaml`) | `anthropic/claude-haiku-4-5` |
| judge (`suite.yaml`) | `anthropic/claude-sonnet-5` |

The suite names no Google model even though `prices.yaml` prices several. On the run day the free tier answered `429 … Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20` for every Gemini Flash model, minutes apart and after idling, so `describe` is the only verb that got through before the quota ran out. Nothing about the suite depends on the provider: change `judges:` in `suite.yaml` and re-run `forge emit`.

The judge is deliberately not the model under test.

## The commands, in order

Everything runs from this directory, with `FORGE_MODEL` set and the provider's key in the environment. The table above is the truth about which verb ran on which model: `describe` ran with `FORGE_MODEL=google/gemini-3.6-flash` and `scenarios` with `anthropic/claude-haiku-4-5`, before the rest settled on:

    export FORGE_MODEL=anthropic/claude-sonnet-5

    bun ../../src/cli/bin.ts describe "Classify one hiring-process email received by a job candidate into exactly one of: rejection, acknowledgement, interview, screening, offer, info_request, unrelated. The answer is a JSON object with type, stage, new_stage, company, job_title, summary. An automated confirmation that an application was received is acknowledgement, never screening or interview." --prompt-file prompt.txt
    bun ../../src/cli/bin.ts review                      # answered: approve
    bun ../../src/cli/bin.ts scenarios
    bun ../../src/cli/bin.ts review --only scenarios     # 7 approved, 5 rejected, 1 edited
    bun ../../src/cli/bin.ts cases --n 3
    bun ../../src/cli/bin.ts dedupe
    bun ../../src/cli/bin.ts review --scenario <id> --all   # once per scenario, after reading its file
    bun ../../src/cli/bin.ts estimate
    bun ../../src/cli/bin.ts emit

    bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2
    bun ../../src/cli/bin.ts report results.json

## What review actually changed

**The feature.** `describe` got it right on the first try and needed no hand fix: `output.kind: json`, `label_field: type`, the seven labels, one `email` text input, and four invariants lifted from the prompt — including the acknowledgement rule. Approved as generated.

**The scenarios.** 13 generated, 8 kept, covering all six kinds with one `rubric` oracle and seven `label`.

Five were rejected:

| rejected | why |
| --- | --- |
| `very-long-email-with-much-context` | "unusually lengthy" adds tokens, not classification signal. |
| `conflicting-stage-signals` | a second `rubric` scenario, and `ambiguous` is already covered by the acknowledgement-vs-screening one, which is the invariant the suite is for. |
| `french-language-interview-request` | the Spanish rejection already covers `language`; this differs only in the language token. |
| `suspicious-attachment-with-stage-claim` | "obfuscated or contains embedded code" is not something a reviewer can write an expected output for. |
| `sparse-email-with-only-company-name` | `fields` oracle, and it overlaps `empty-subject-and-minimal-body`. |

One was **edited**: `formal-job-offer-letter` came back with `oracle: fields`. Rejecting it would have dropped the `offer` label from the suite entirely, so it was edited to `oracle: label` through `forge review`'s `edit` path instead — which is why its status on disk is `edited`, not `approved`.

**The cases.** 3 per scenario, 24 in all, every one read before it was approved. **None was rejected and none was edited**: the expected label was right in all 24, including the three the scenario set out to make hard — the receipt that also asks for a 15-minute skills assessment (`screening`, because a human is asking the candidate to do something), and the two prompt-injection cases whose bodies order the classifier to answer `offer` and `interview` (`acknowledgement` and `rejection`, ignoring the injected instruction).

`forge dedupe` flagged 12 of the 24 with `duplicate_of`. All 12 were **kept**. Three cases drawn from one scenario are near-duplicates by construction — that is what a scenario is — and `dedupe` flags without removing, on purpose. The flagged inputs differ in company, role, channel and wording, so each is still a distinct test; the flag is a prompt to look, and looking is what happened.

The one expected value worth arguing about is `empty-subject-and-minimal-body-03`, whose rubric asks for `company` to be null on a one-word email from a recruiting domain. A model that infers the company from the sender would fail it. It was left as generated: a failure there would be a finding about the application, not about the case.

## The estimate

    $ bun ../../src/cli/bin.ts estimate
    estimate: 24 cases, 3 with a rubric; prices dated 2026-09-15
      target  anthropic/claude-haiku-4-5           48 calls   23036 in    5760 out  $0.051836
      judge   anthropic/claude-sonnet-5             6 calls    2184 in     480 out  $0.009168
      total                                                                         $0.061004
    note: tokens are estimated as characters / 4; output size is a guess from output.kind

## The run

    $ bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2
    ✓ 48 passed (100%)  ·  0 failed (0%)  ·  0 errors (0%)  ·  Duration: 36s (concurrency: 2)

    $ bun ../../src/cli/bin.ts report results.json
    report: 48 of 48 rows matched; pass rate 100.0%; 0 flaky; 0 judge disagreements

Every scenario ran 6 times (3 cases × `repeat: 2`) and passed 6 times. The judge cost came in at $0.009126 against an estimate of $0.009168 — 0.5% low. The target line reads $0.000000 against $0.051836, which is not a saving: the shim reports zero tokens (see below), so `report.md` says so in as many words rather than printing a number it does not have.

Two kinds of noise on stderr are expected and are not failures: promptfoo 0.123.0 prints `ExperimentalWarning: DecompressInterceptor`, and the Python worker prints an `asyncio` traceback ending in `RuntimeError: Event loop is closed` when it tears down moonlighter's HTTP client after the loop has closed. All 48 rows still carry a result.

## Two honest limitations of the shim

`.forge/forge_target.py` is the generated shim with `run_application` filled in. It calls `classify_response` directly, so the suite measures the real application, not a copy of its prompt. Two things it does not do well:

1. **It reports no tokens.** moonlighter's `make_api_caller()` does not hand back usage, so the shim returns `input_tokens: 0`, `output_tokens: 0` and the target row of the cost table is empty. Wiring moonlighter's own call log through would make that line real.
2. **It reassembles the email by splitting on the first blank line.** The forge carries one `email` string; moonlighter wants `{from_, subject, body}`. Where a generated case wrote the body on the same line as a `Body:` prefix, that first line is read as a header and does not reach `body`; where a case has no blank line at all (the three one-word `empty-subject-and-minimal-body` cases), `body` arrives empty — which is why moonlighter's own summaries for those three say "Email is empty". They still classify as `unrelated` and still pass, but the suite is testing a slightly thinner input than the case file shows.

## Rerunning it

    # point target.python in .forge/suite.yaml at a Python that can `import moonlighter`
    $ bun ../../src/cli/bin.ts emit            # rewrites promptfooconfig.yaml; keeps forge_target.py

    $ export ANTHROPIC_API_KEY=...             # target and judge
    $ export MOONLIGHTER_HOME=$(mktemp -d)     # keeps moonlighter's call log out of ~/.moonlighter
    $ bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json --no-cache --no-progress-bar -j 2
    $ bun ../../src/cli/bin.ts report results.json --baseline .forge/report.json

`suite.yaml` is committed with `python: .venv/bin/python`, which is a placeholder, not a path that exists here: the run used an absolute path to moonlighter's own virtualenv on the machine it ran on, and it was put back before committing so the file does not carry one person's home directory. `results.json` still names that absolute path, because it is promptfoo's own unedited record of the run and editing it would make it a worse record. `forge emit` copies whatever it finds there into `promptfooconfig.yaml` as `pythonExecutable`, so change `suite.yaml` and re-emit rather than editing the emitted config.

`bun run validate:example`, from the repository root, checks this config with the real promptfoo and needs no key; CI runs the same command on every push.
