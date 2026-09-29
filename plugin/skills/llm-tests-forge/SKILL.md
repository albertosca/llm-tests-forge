---
name: llm-tests-forge
description: Use when the person wants tests, evals or a regression suite for an LLM feature, an LLM prompt, or a function that calls an LLM in this project, or asks what LLM evals exist — "create LLM tests for this function", "add an LLM eval suite for this feature", "test this LLM prompt", "what LLM evals do we have", "cria testes de LLM pra essa função", "testa esse prompt de LLM", "monta a suíte de evals do LLM". Not for ordinary unit tests of code that does not call an LLM, nor for questions about promptfoo itself. Works through the llm-tests-forge command.
---

# llm-tests-forge

This project's LLM regression suites are made with the `llm-tests-forge` command. Its manual ships inside the installed binary, so it always matches the installed version:

1. Run `llm-tests-forge status` to see which suites exist and what is pending.
2. Run `llm-tests-forge guide` and follow it.

Approving is the person's job: never mark anything approved by editing files, and never run `llm-tests-forge review` for them. When a review is due, stop and ask them to run it.

Installed as a project dependency, call it as `npx llm-tests-forge`, `uv run llm-tests-forge`, `bundle exec llm-tests-forge`, or `_build/llm-tests-forge` under Elixir.

If `llm-tests-forge` is not installed, say so and point to https://github.com/albertosca/llm-tests-forge for installation.
