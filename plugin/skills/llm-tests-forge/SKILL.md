---
name: llm-tests-forge
description: Use when the person wants tests, evals or a regression suite for an LLM feature, prompt or function in this project, or asks what LLM tests exist — "create LLM tests for this function", "add an eval suite", "test this prompt", "what evals do we have", "cria testes pra essa função", "testa esse prompt", "monta a suíte de evals". Works through the llm-tests-forge command.
---

# llm-tests-forge

This project's LLM regression suites are made with the `llm-tests-forge` command. Its manual ships inside the installed binary, so it always matches the installed version:

1. Run `llm-tests-forge status` to see which suites exist and what is pending.
2. Run `llm-tests-forge guide` and follow it.

Approving is the person's job: never mark anything approved by editing files, and never run `llm-tests-forge review` for them. When a review is due, stop and ask them to run it.

If `llm-tests-forge` is not installed, say so and point to https://github.com/albertosca/llm-tests-forge for installation.
