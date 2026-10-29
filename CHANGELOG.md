# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.0 - 2026-10-29

First release, published to npm; the PyPI, RubyGems, Hex and Homebrew packages are built too and publish once their tokens are set.

### Added

- The review pipeline: `describe`, `scenarios`, `cases`, `dedupe`, `import`, `review` and `move`, over plain YAML under `.forge/`. Six scenario kinds (happy, edge, ambiguous, out-of-scope, adversarial, language), every case with an expected output, and a review in which a person approves each item.
- `estimate`, which prices a run before it is spent, as a calibrated range against a `prices.yaml` you can edit.
- `emit`, which writes a promptfoo config (or `--format jsonl`) and a shim for nine target kinds: python, javascript, typescript, elixir, ruby, rust, go, exec and http.
- `report`, which turns promptfoo's output into a per-scenario report with flaky cases, judge disagreements, real against estimated cost and a comparison with a baseline.
- `stamp` and `check`, which seal a passing run to the files, models and pass rate it was earned on, and verify offline in CI that none of them moved.
- Providers for the drafter: Anthropic, Google, OpenAI and Ollama.
- Prebuilt binaries for macOS (arm64, x64), Linux glibc (x64, arm64) and Windows x64, and packages for npm, PyPI, RubyGems, Hex and Homebrew, with a checksum check and a GitHub artifact attestation.
- `init`, `status` and `guide`, so a person or an agent with no chat history can find out what exists and what is pending.
