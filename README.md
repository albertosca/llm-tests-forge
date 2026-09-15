🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml)

# llm-test-forge

Forge reviewed regression suites for the LLM features in your application.

Describe what your feature does, and the forge enumerates scenarios of six kinds (happy, edge, ambiguous, out-of-scope, adversarial, language), generates cases per scenario with an expected output, and lets you review every one of them in plain files, one by one. Running the suite, estimating cost, and emitting a config for a runner like [promptfoo](https://promptfoo.dev) are not part of this tool yet — see "What this does not do yet" below.

## Install

Requires [bun](https://bun.sh) 1.4 or newer.

    bun install
    bun link      # exposes `forge` on your PATH

## Use

Run these in order, from the root of the application whose LLM feature you are testing.

    export FORGE_MODEL=google/gemini-3.5-flash
    forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file src/prompt.txt

Writes `.forge/feature.yaml` as a pending, structured description of the feature (purpose, inputs, output shape, invariants). `--prompt-file` is optional; pass it when the application has a real system prompt worth copying rules from.

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

## What this does not do yet

- It does not run the suite against a model and compare outputs.
- It does not estimate the token cost of a run before you spend it.
- It does not emit a config for promptfoo or any other test runner.

Those are a separate, later piece of work; see `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md` for the full design and where this tool stops today.

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

    bun test          # unit tests, no network, 100% coverage gate
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, then typecheck, then test
    bun run test:live  # one real call per verb against FORGE_MODEL, needs a provider key (FORGE_LIVE=1)

Design: `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md`.

## License

MIT — see `LICENSE`.
