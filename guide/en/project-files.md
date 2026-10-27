# Agents, files and exit codes

## Agents

`init` adds a block to `AGENTS.md` that points an agent at `llm-tests-forge status` and `llm-tests-forge guide`. The rule in that manual is the important one: approving is the person's job, so an agent never marks anything approved by editing a file and never runs `review` for you.

A Claude Code skill (`plugin/skills/llm-tests-forge/`) is a thin pointer to the same manual. The install command is `/plugin marketplace add albertosca/llm-tests-forge`, and it works once the repository is public. Until then, `/plugin marketplace add <path to your clone>` installs it from a local checkout.

## What to commit under `.forge/`

Commit:
- `forge.yaml`;
- in each suite, `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, the shim and `report.md`/`report.json`.

They are the reviewed suite, the run it describes and the result, and their diffs are the point.

Gitignore `usage.jsonl` and `failures/`, which hold token counts and raw model output from your own runs.

Decide deliberately about `cases/imported.yaml`: `import` fills it with real production inputs, which may be data you cannot put in a repository.

## Exit codes

| Code | Means |
|---|---|
| `0` | the verb did what it says |
| `1` | the work failed: a file that is not there, a model that refused, a feature still pending review |
| `2` | the command line is unusable: an unknown verb or option, a bad flag value, a missing required argument, no model configured |
