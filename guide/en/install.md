# Install

One prebuilt binary, several ways to get it. Release 0.1.0 is on npm; the other channels publish as their tokens are set up, so until a channel's package appears, use npm, the script or the clone at the end of this section.

    npm i -D llm-tests-forge                # JavaScript / TypeScript
    uv add --dev llm-tests-forge            # Python
    brew install albertosca/tap/llm-tests-forge   # any project
    curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh   # any project

**Elixir.** Add the dependency to `mix.exs`, then fetch the binary:

    {:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}
    mix deps.get
    mix llm_tests_forge.install

An interactive `review` runs as `_build/llm-tests-forge review`, because `mix llm_tests_forge review` refuses (exit 2). `review --scenario <id> --all` asks nothing and runs through mix.

**Ruby.** Add `gem "llm-tests-forge", group: :development` to the `Gemfile` and run `bundle install`.

**Rust and Go.** There is no package of their own: use Homebrew or the script.

**`install.sh` options.**
- It writes to `~/.local/bin`; `--dir <bin-directory>` chooses another.
- `--version vX.Y.Z` pins a release.
- Through the pipe, pass the options after `sh -s --`.

**From a clone** (needs [bun](https://bun.sh) 1.4 or newer):

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install
    bun link      # puts `llm-tests-forge` in bun's global bin directory, ~/.bun/bin by default

Running a suite needs promptfoo, which is Node. The forge itself does not, and never runs promptfoo for you.

**Platforms.**
- The binaries cover macOS (arm64, x64), Linux with glibc (x64, arm64) and Windows x64.
- Anywhere else, musl/Alpine included, pip and gem install a fallback package with no binary. Its command says so and exits 1, as npm's and `install.sh` do.
- On a supported platform, the fallback says how to get the binary instead: pip's `--platform`, Bundler's `force_ruby_platform`, `bundle lock --add-platform` (for a `Gemfile.lock` whose `PLATFORMS` lack this platform), or `gem install --platform ruby`.

## Verifying a download

`install.sh` makes two checks, and they prove different things.

- **Integrity.** The binary's SHA256 must match the release's `SHA256SUMS`. That proves the download arrived intact, not who built it, since both come from the same place. Homebrew and Hex pin each binary's hash in the package itself instead.
- **Provenance.** Every release binary and `SHA256SUMS` carry a GitHub artifact attestation, signed through Sigstore by this repository's release workflow. With [`gh`](https://cli.github.com) 2.49 or newer on the PATH, the script verifies it, logged in or anonymously (GitHub allows 60 anonymous API requests an hour per address).

What you see:
- **The attestation verifies:** one line says so.
- **It does not verify:** nothing is installed, and the script prints what `gh` said and what to check.
- **`gh` is missing or older than 2.49:** the binary is installed on its checksum alone. The script says provenance was not checked and prints the command that checks it later, which works on any downloaded binary:

      gh attestation verify ~/.local/bin/llm-tests-forge --repo albertosca/llm-tests-forge --signer-workflow albertosca/llm-tests-forge/.github/workflows/release.yml --deny-self-hosted-runners

Two details worth knowing:
- `install.sh` always asks github.com, even when `GH_HOST` names another host, so a GitHub Enterprise token in `GH_TOKEN` or `GITHUB_TOKEN` is rejected there. Unset it for the install.
- To install on the checksum alone after a refusal, set `LLM_TESTS_FORGE_PROVENANCE=skip` for `sh`. The script then says, with a warning, that provenance was not checked. This does not prove who built the binary.
