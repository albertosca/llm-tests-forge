# CLAUDE.md

A Bun/TypeScript CLI that generates, reviews and emits promptfoo test suites for LLM features. `src/core` (files, cases, oracles, estimate) · `src/cli` (verbs and the review loop) · `src/emit` (promptfoo) · `src/report` · `src/llm` (providers). Outside `src/`: `packages/` (the gem, Hex and PyPI shims around the binary), `scripts/release`, `scripts/mutation`, `scripts/examples`, `examples/`, `install.sh`, `plugin/`.

## Commands

- Full gate: `bun run check` (biome lint + `tsc --noEmit` + `bun test`). `bunfig.toml` holds per-file coverage at 100% lines and functions, so a subset run ends red on coverage; that is an artifact, the whole run is the green that counts.
- Outside `bun run check`, each with its own CI job: `bun run lint:ruby`, `lint:elixir`, `lint:python` (the gem, Hex and PyPI packages; the first CI run caught a RuboCop module-length failure that `check` could not see), `bun run check:examples` (regenerates each committed example report from its `results.json`, and from `baseline-report.json` where one exists), and the opt-in suites `test:packages`, `test:shims`, `test:live` (off by default, each behind an environment variable; they install into Homebrew, RubyGems and so on, or call real models).
- Mutation testing: `bun run mutation <scope>` for `core`, `cli`, `emit`, `report` or `llm`; every scope has `break` at 100, so a new mutant must be killed or disabled with a reason. The whole `cli` scope is the one that matters after a change in `src/cli` (per-file runs hid survivors once) and takes about 6.5 minutes locally. CI runs it by `workflow_dispatch`, weekly and on pull requests, never on a push to `main`.
- Bun is pinned to 1.4.4 in every workflow. A Bun upgrade has broken tests before (1.4.4 against 1.4.2), so move the pin together with a green full run.
- After a pull or merge that changes `bun.lock`, run `bun install --frozen-lockfile`: `tests/mutation/stryker-typescript.test.ts` fails with ENOENT on `node_modules/typescript5` when `node_modules` is behind.

## Mutation type-checker

Stryker's checker runs TypeScript 7 (the native port) in its experimental native mode, but still imports TypeScript's JavaScript API, which version 7 does not export. `scripts/mutation/stryker-typescript-resolve.mjs` sends those imports to a `typescript5` alias. Upstream has no supported path yet (stryker-js issue 5213).

## Docs

`docs/superpowers/` is a symlink to `~/Programming/private-project-docs/llm-tests-forge` (a separate private repository). Git run from this checkout sees nothing inside it; commit there with `git -C`. Plans, specs, `PROJECT-LOG.md` and `BACKLOG.md` live there.

## Publishing

This repository is private on purpose; publishing it is a deliberate step with a history rewrite first (see `BACKLOG.md`). Until then the README badges do not render.
