# Engineering decisions

**The forge writes config; promptfoo runs it.** Providers, concurrency, caching and the results viewer are promptfoo's. The forge owns what to test and what "correct" means, and its emitter sits in its own module, `src/emit`. `--format jsonl` hands the same selection to a runner of your own. The cost is one emitter today and a dependency on promptfoo's config format.

**Approval is a human act.** A drafted item is pending until a person decides on it in `review`. The agent manual says an agent never marks anything approved by editing a file and never runs `review`, and `emit` refuses to write while anything is pending.

**Expected outputs are plain files.** YAML under `.forge/`, one file of cases per scenario, so a change to what "correct" means is a diff someone has to read and approve.

**Estimates are ranges.** Nothing about the real answer exists before the run, so `estimate` reports a band around its point, calibrated on the few runs committed here: a guess, not a budget. A provider with no price row is left unpriced and counted as left out, never priced as something else. The arithmetic is under [`estimate`](running-a-suite.md#estimate).

**Sealing is offline.** `check` reads files and compares; it calls no model. It proves that one run passed on those inputs, not that the feature works.

**Writes fail safe.**
- `move` writes the destination before touching the source, so a failure part-way leaves a duplicate, not a missing case.
- The first Ctrl+C in a review saves what was decided; a second one before the save aborts without writing.
- The shim is written once and never overwritten.

**One binary, thin packages.**
- Every channel installs the same prebuilt binary. Its checksum is verified, and its provenance through a GitHub artifact attestation signed by the release workflow.
- A final release stops if the attestation fails. Only a prerelease tag (one holding a hyphen, such as `v0.2.0-rc.1`) in a private repository goes on with a warning, since GitHub Free, Pro and Team plans have attestations for public repositories only.
- The repository therefore has to be public, or on a plan with attestations for private ones, before the first final release.

**A strict gate.**
- Every file is held at 100% line and function coverage.
- The five modules (`core`, `cli`, `emit`, `report`, `llm`) are mutation-tested with the threshold at 100, so a surviving mutant is either killed or disabled with a stated reason.
- The committed example reports are regenerated from their raw results in CI, and the Ruby, Elixir and Python packages have their own linters.
- Bun measures no branch coverage, so a file at 100% can still hide untested guard arms: the gate is a floor, not proof that the suite is complete.
