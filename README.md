🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml)

# llm-test-forge

Forge reviewed regression suites for the LLM features in your application.

Describe what your feature does, and the forge enumerates scenarios of six kinds (happy, edge, ambiguous, out-of-scope, adversarial, language), generates cases per scenario with an expected output, and lets you review every one of them in plain files, one by one. Then it prices the run before you spend it, emits a config for [promptfoo](https://promptfoo.dev) to run, and turns promptfoo's output back into a report with a per-scenario table, flaky cases and real-against-estimated cost.

A finished suite, generated and reviewed against a real application: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/).

## Install

Requires [bun](https://bun.sh) 1.4 or newer. This is not published to npm yet, so install it from a clone.

    git clone https://github.com/albertosca/llm-test-forge.git
    cd llm-test-forge
    bun install
    bun link      # exposes `forge` on your PATH

## Use

Run these in order, from the root of the application whose LLM feature you are testing.

    export FORGE_MODEL=google/gemini-3.5-flash
    forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file src/prompt.txt

Writes `.forge/feature.yaml` as a pending, structured description of the feature (purpose, inputs, output shape, invariants). `--prompt-file` is optional; pass it when the application has a real system prompt worth copying rules from. Running `describe` again over a feature you have already reviewed is refused, because it would overwrite the invariants you wrote by hand; pass `--force` when replacing it is what you want.

    forge review

Opens an interactive review of whatever is pending — here, the feature. Approve it, edit it, or reject it; approval unblocks the next step.

    forge scenarios

Generates `.forge/scenarios.yaml`: a set of scenarios covering all six kinds for the approved feature.

    forge review --only scenarios

Reviews the pending scenarios one by one.

    forge cases --n 5

Generates 5 pending cases per approved scenario in `.forge/cases/<scenario-id>.yaml`, each with an expected output computed from the feature's oracle shape (label, fields, or rubric).

    forge dedupe

Flags likely-duplicate cases within each scenario (`duplicate_of`) without removing them.

    forge import logs/real-inputs.jsonl

Reads one `{"input-name": "value"}` JSON object per line from real production logs and adds them as pending cases in the `imported` scenario, without an expected output — you supply that during review.

    forge review

Reviews everything still pending: cases (confirming or fixing the expected output), and any imported case (setting its expected output for the first time).

At the end, `.forge/` holds `feature.yaml`, `scenarios.yaml`, and `cases/<scenario>.yaml` — plain YAML, meant to be committed and diffed like any other test fixture.

The remaining three verbs turn that suite into a run. They read `.forge/suite.yaml`, which you write by hand: what the suite runs against, which models judge a `rubric` case, and how many times each case repeats.

    # .forge/suite.yaml
    target:
      kind: promptfoo-python
      entry: forge_target.py
      python: .venv/bin/python        # an interpreter that can import your application
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # empty = every reviewed scenario

    forge estimate

Prices the run before you spend it: cases × target models × `repeat`, plus one judge call per `rubric` case per judge, target model and `repeat`, against `prices.yaml` (which is yours to edit — the output prints the date it carries, and marks with `~` any model it had to price as its closest listed sibling). Tokens are counted as characters ÷ 4, so read it as an order of magnitude. It makes no API call.

    forge emit

Writes `.forge/promptfooconfig.yaml` from the approved cases: one test per case with its inputs as `vars`, a `javascript` assert for a `label` or `fields` oracle, and one `llm-rubric` per judge for a `rubric` one. It refuses to emit while anything is still pending, and names what. On the first run it also writes `.forge/forge_target.py` and never overwrites it again — **edit its `run_application` to call your application**, which is what makes the suite test your code rather than a copy of your prompt. `--format jsonl` writes the same selection as `.forge/cases.jsonl` instead, for a runner of your own.

    bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

Promptfoo runs the suite; the forge does not run it for you and does not need promptfoo installed.

    forge report results.json [--baseline .forge/report.json]

Reads promptfoo's output into `.forge/report.md` and `.forge/report.json`: pass rate, a per-scenario table, which reviewed scenarios never ran, cases that passed on one repeat and failed on another, judges that disagreed (with both reasons), and real cost against the estimate. With `--baseline`, an earlier `report.json` is compared and regressions are listed first.

### What to commit under `.forge/`

Commit `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, `forge_target.py` and `report.md`/`report.json`: they are the reviewed suite, the run it describes and the result, and their diffs are the point. Gitignore `usage.jsonl` and `failures/`, which hold token counts and raw model output from your own runs, and decide deliberately about `cases/imported.yaml` — `import` fills it with real production inputs, which may be data you cannot put in a repository.

### Exit codes

| Code | Means |
|---|---|
| `0` | the verb did what it says |
| `1` | the work failed: a file that is not there, a model that refused, a feature still pending review |
| `2` | the command line is unusable: an unknown verb or option, a bad flag value, a missing required argument, no model configured |

## What this does not do yet

- It does not call promptfoo for you: `forge emit` writes the config and you run the eval yourself.
- There is no MCP server, so the review loop cannot run inside a conversation.
- It tests one turn at a time. Multi-turn cases where your application's own reply shapes the next turn need a simulated user, which this is not.
- It keeps no history: `--baseline` compares two runs, and nothing collects them over time.

See `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md` for the full design and `docs/superpowers/BACKLOG.md` for what is deferred and why.

## Providers

Set `FORGE_MODEL` or pass `--model` as `provider/model`:

| Provider | Env var | Example |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | none (local) | `ollama/llama3` |
| `fake` | none | `fake/path/to/responses.json`, for tests |

## Develop

    bun test          # unit tests, no network, coverage gate
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, then typecheck, then test
    bun run test:live  # two real calls against google/gemini-3.5-flash by default (FORGE_LIVE=1); override with FORGE_MODEL
    bun run validate:example  # checks the committed example's promptfooconfig.yaml with the real promptfoo; no API key

The coverage gate is bun's own: a 1.0 floor on **lines and functions**, with `src/cli/bin.ts` excluded. Bun measures no branch coverage at all, so a file at 100% can still have untested guard arms — read the gate as a floor, not as proof the suite is complete.

`test:live` needs `GOOGLE_API_KEY` and fails loudly (not silently) if it's unset. Google's free tier is intermittent rather than simply down, so the test retries a 503/"high demand" response up to 3 attempts with a short pause between them; any other failure (quota, auth, an unknown model id, a schema mismatch) fails on the first occurrence instead of retrying.

Design: `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md`.

## License

MIT — see `LICENSE`.
