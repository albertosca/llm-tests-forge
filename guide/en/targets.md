# The nine target kinds

The shim lives in `.forge/<entry>`, using the default names below unless `target.entry` renames it. `emit` writes it once and never overwrites it; you fill in the one function it names.

| `target.kind` | What `emit` writes | What you fill in |
|---|---|---|
| `python` | `forge_target.py` | `run_application`; `target.python` sets the interpreter promptfoo runs, which must be able to import your code |
| `javascript` | `forge_target.mjs` | `runApplication` |
| `typescript` | `forge_target.ts`, which promptfoo loads directly | `runApplication` |
| `elixir` | `forge_target.exs`, run through `mix run` from the mix project (Elixir 1.18 or newer, for JSON) | `run_application/2`; run `mix compile` before the first run |
| `ruby` | `forge_target.rb` | `run_application` |
| `rust` | the `forge_target/` crate (`Cargo.toml`, `src/main.rs`) | uncomment the dependency on your crate, fill `run_application`, build once with `cargo build --release` inside `.forge/forge_target/` |
| `go` | the `forge_target/` module (`go.mod`, `main.go`) | uncomment the `require` and `replace` lines, fill `runApplication`, build once with `GOWORK=off go build -o forge_target .` inside `.forge/forge_target/` |
| `exec` | nothing | `target.command` in `suite.yaml` names the program; it runs from `.forge/`, so a relative command is relative to `.forge/` |
| `http` | nothing | `target.url`, and optionally `method`, `headers`, `body` (each of the feature's inputs is available as `{{<input name>}}`; the default body is one key per input) and `response` (an expression over `json`, with no `=>`); `emit` replaces `{{target_model}}` in `url`, a header value or `body` with each provider's model |

**What an `exec` command receives.** promptfoo runs it from `.forge/`, once per case and target model, with three arguments:
1. the rendered prompt (the feature's first input);
2. the provider options as JSON (the model is at `config.model`);
3. the context as JSON (the case's inputs are under `vars`, which also holds promptfoo's own keys starting with `__`, to ignore).

Standard input is empty. The answer goes to standard output and logs to standard error. A failure is a message on standard error and a non-zero exit status, which promptfoo shows as an error row.

**For `http`**, `emit` itself substitutes `{{target_model}}`, nested strings of `body` included, before the config is written. With more than one `target.models` and no `{{target_model}}` anywhere, every provider sends the same request, and `emit` prints a warning saying so.

**For every exec-style shim:**
- It answers on stdout, so your application must log to stderr.
- Compile the project (`mix compile`, `cargo build`, `go build`) before the first run. promptfoo runs cases concurrently, and a first compile racing itself is not verified safe.
- A shim that fails (a non-zero exit status, or an error it returns) shows as an error row in promptfoo, not as a failed assert.
