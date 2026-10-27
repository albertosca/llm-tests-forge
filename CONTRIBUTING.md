# Contributing

Thanks for looking. This is a small Bun/TypeScript CLI with a strict test gate; the notes below are what a change has to pass.

## Set up

You need [bun](https://bun.sh) 1.4.4 (the version every workflow pins; a Bun upgrade has broken tests before, so the pin moves only together with a green full run).

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install --frozen-lockfile

After a pull or merge that changes `bun.lock`, run `bun install --frozen-lockfile` again.

## The gate

    bun run check

runs Biome, `tsc --noEmit` and the whole test suite. `bunfig.toml` holds per-file coverage at 100% of lines and functions, so a run of a subset of the tests ends red on coverage. That is an artifact of the subset; the whole run is the green that counts.

Four more checks have their own CI jobs and are not part of `bun run check`:

- `bun run lint:ruby`, `bun run lint:elixir`, `bun run lint:python` for the gem, Hex and PyPI packages in `packages/`.
- `bun run check:examples` regenerates each committed example report from its `results.json` and compares it with the committed one.

Three suites are off by default, each behind an environment variable, because they install into real toolchains or call real models: `bun run test:packages`, `bun run test:shims`, `bun run test:live`.

## Mutation testing

Every scope has its gate at 100, so a new surviving mutant fails the run. After a change under `src/`, run the scope that owns the file:

    bun run mutation core      # src/core
    bun run mutation cli       # src/cli — run the whole scope, a single file once hid survivors
    bun run mutation emit
    bun run mutation report
    bun run mutation llm

A mutant is killed by a test that fails because of it, or disabled with a comment that says why it cannot matter. A scope takes from a few minutes to about twenty on a laptop; CI runs them on pull requests.

## Style

- Variable and parameter names are whole words (`index`, not `i`; `error`, not `e`; `options`, not `opts`). Acronyms that are the word (`id`, `url`, `api`) are fine.
- Code, comments and commit messages are in English.
- Commit messages are an imperative sentence that starts with the area: `review: say what the Expected is for`.
- A change that fixes a bug brings the test that fails without it. Do not add tests for cases that cannot happen.

## What not to automate

The review loop is the point of the tool: a person approves each scenario and case. A change that lets an agent or a script approve for the person goes against that. The manual the binary prints (`llm-tests-forge guide`) says an agent never marks anything approved by editing a file and never runs `review` for you; keep it true.

## Proposing a new emit target

`emit --format` already takes a format, and each eval library is one more emitter over the same reviewed files. Open a feature request first with the library, why a project would choose it over promptfoo, and how its judge is wired (several libraries need hand-written glue for the judge model).

## Security and conduct

Report a vulnerability through GitHub's private vulnerability reporting (see [SECURITY.md](SECURITY.md)), not in a public issue. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
