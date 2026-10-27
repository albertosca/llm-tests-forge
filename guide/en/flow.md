# From your prompt to a promptfoo suite

The forge sits between the code that calls your model and [promptfoo](https://promptfoo.dev), which runs the tests. It decides what to test and what "correct" means; promptfoo executes. Nothing in between is a service: every step reads and writes plain files under `.forge/`, next to your code.

## The path, step by step

| # | You run | The forge writes | Who decides |
|---|---|---|---|
| 1 | `init` | `forge.yaml`, a block in `AGENTS.md` | you |
| 2 | `describe "..." --prompt-file prompt.txt` | `.forge/feature.yaml`: purpose, inputs, output shape, invariants | the drafter proposes, you approve in `review` |
| 3 | `scenarios` | `.forge/scenarios.yaml`: situations of six kinds (happy, edge, ambiguous, out-of-scope, adversarial, language) | the drafter proposes, you approve |
| 4 | `cases --n 5` | `.forge/cases/<scenario>.yaml`: inputs, an expected output and an oracle (`label`, `fields` or `rubric`) | the drafter proposes, you confirm or correct each one |
| 5 | `dedupe`, optionally `import logs.jsonl`, then `review` | flags duplicates; adds real production inputs as cases you complete | you |
| 6 | `estimate` | nothing; prints a price range, with no API call | you read it before spending |
| 7 | `emit` | `.forge/promptfooconfig.yaml` and, once, a shim in your language | `emit` refuses while anything is pending |
| 8 | `npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json` | promptfoo's `results.json` (exit 100 when any test fails: a result, not a crash) | promptfoo |
| 9 | `report results.json [--baseline]` | `.forge/report.md` and `.forge/report.json` | you read it |
| 10 | `stamp results.json`, then `check` in CI | `.forge/stamp.json`; `check` is offline and calls no model | you seal, CI verifies |

The prompt you pass to `describe` is read once, to copy its rules into the feature description. After that the suite tests whatever your code does, through the shim.

## What `emit` produces

**The config.** One promptfoo test per approved case, with the case's inputs as `vars`. A `label` or `fields` oracle becomes a `javascript` assert; a `rubric` becomes one `llm-rubric` per judge. A trimmed example, from [`examples/moonlighter-classify-email/`](../../examples/moonlighter-classify-email/):

    providers:
      - id: file://forge_target.py
        label: anthropic/claude-haiku-4-5
        config:
          model: anthropic/claude-haiku-4-5
    tests:
      - description: standard-interview-request-email-01
        vars:
          from: Priya Nair <priya.nair@brightwave.io>
          subject: Interview Invitation - Senior Backend Engineer
          body: ...
        assert:
          - type: javascript
            value: ... # parses the output and compares "type" with "interview"

**The shim.** promptfoo calls it once per case and per target model. Its job is to call *your* function with the case's inputs and hand back the answer, which is what makes the suite test your application and not a copy of your prompt. `emit` writes it once and never overwrites it; you fill in the single function it names.

| Your code is | The shim is | You fill in |
|---|---|---|
| Python | `forge_target.py` | `run_application` |
| JavaScript / TypeScript | `forge_target.mjs` / `forge_target.ts` | `runApplication` |
| Elixir | `forge_target.exs`, through `mix run` | `run_application/2` |
| Ruby | `forge_target.rb` | `run_application` |
| Rust / Go | a small crate / module | `run_application` / `runApplication` |
| anything else | nothing | `target.command` (any program) or `target.url` (an HTTP endpoint) in `suite.yaml` |

The details of each kind, including the `exec` and `http` contracts, are in [The nine target kinds](targets.md).

**A runner of your own.** `emit --format jsonl` writes the same approved selection to `.forge/cases.jsonl` instead, for a tool that is not promptfoo. promptfoo is the only emitter today; more are planned, and each would read the same reviewed files.

## Where each step is documented

- Steps 1 to 5: [Building a suite](building-a-suite.md).
- Steps 6 to 10: [Running a suite](running-a-suite.md).
- Which files to commit, how an agent fits in, exit codes: [Agents, files and exit codes](project-files.md).
