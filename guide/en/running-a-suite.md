# Running a suite

The remaining verbs turn that suite into a run. They read `.forge/suite.yaml`, which `describe` may have started for you and which you otherwise write by hand. It says what the suite runs against, which models judge a `rubric` case, and how many times each case repeats.

    # .forge/suite.yaml
    target:
      kind: python
      entry: forge_target.py          # optional: the shim, when not the default name
      python: .venv/bin/python        # an interpreter that can import your application
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # empty = every approved scenario

- `target.kind` is one of the nine kinds [below](targets.md). `kind: promptfoo-python`, which older suites carry, still reads as `python`.
- The kind-specific keys are `target.python` (python), `target.command` (exec), and `target.url`, `target.method`, `target.headers`, `target.body` and `target.response` (http).

### `estimate`

    llm-tests-forge estimate

Prices the run before you spend it. It makes no API call.

- **What it counts:** cases × target models × `repeat`, plus one judge call per `rubric` case per judge, target model and `repeat`.
- **Where prices come from:** `prices.yaml`, which is yours to edit. The output prints the date the file carries, and marks with `~` any model it had to price as its closest listed sibling.
- **Unknown providers:** a model whose provider has no row at all is not priced as anything. Its line reads `not priced`, and the total leaves it out and says how many lines it left out.
- **Tokens** are counted as characters ÷ 4. Every line and the total show a range around that point, `$low–$high (point $point)`, built from three pieces:
  - the input, re-counted at 3.5 to 4.2 characters per token;
  - the judge's prompt overhead and answer size, taken from recorded runs;
  - the target's output, at 0.5× to 1.25× of a size guessed from `output.kind` (or from the reviewed expected values), because nothing of the real answer's text exists before the run.
- **How far to trust it:** the bands were fit to the few runs committed with this repository, so read the range as a calibrated guess, not a budget.

### `emit`

    llm-tests-forge emit

Writes `.forge/promptfooconfig.yaml` from the approved cases:
- one test per case, with its inputs as `vars`;
- a `javascript` assert for a `label` or `fields` oracle, and one `llm-rubric` per judge for a `rubric` one;
- a refusal, naming what, while anything is still pending.

On the first run it also writes the shim for your language, once and never overwritten again. **Fill in the function it names to call your application**: that is what makes the suite test your code rather than a copy of your prompt.

`--format jsonl` writes the same selection as `.forge/cases.jsonl` instead, for a runner of your own.

### Run promptfoo

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

Promptfoo runs the suite from the suite directory (`bunx` works too). The forge does not run it for you. promptfoo exits with status 100 when any test fails: that is a result, not a crash.

### `report`

    llm-tests-forge report results.json [--baseline .forge/report.json]

Reads promptfoo's output into `.forge/report.md` and `.forge/report.json`. They show:
- the pass rate and a per-scenario table;
- which reviewed scenarios had no case, no matched run, or were not in this suite;
- cases that passed on one repeat and failed on another;
- judges that disagreed, with both reasons;
- real cost against the estimate's range: within it, or how far above or below its nearer bound. A line that recorded no tokens says so instead of claiming a match.

With `--baseline`, an earlier `report.json` is compared:
- regressions are listed first;
- pairs the baseline has and this run does not (after a rename, say) are named rather than silently left out of the diff;
- a baseline written by an older version of the forge is accepted, keys it spelled differently included.

### `stamp` and `check`

    llm-tests-forge stamp results.json
    llm-tests-forge check

A run only protects you if something notices when its inputs move.

**`stamp`** seals a passing run to the files you list in `suite.yaml` (`stamp.inputs`: the prompt file, a lockfile; `stamp.minimum_pass_rate`: the line), in `.forge/stamp.json`, which you commit. It refuses, writing nothing, while:
- any case fails on every repeat;
- the pass rate is under the line;
- an input is missing.

A case that failed on only some repeats is listed in the stamp and does not block it.

**`check`** is what CI runs: offline, no model call. It exits 1 naming:
- the input that changed, vanished or appeared;
- the target model or judge that differs from the sealed one;
- a line raised above the sealed pass rate.

It only warns when the forge or promptfoo version differs.

Sealing is a maintainer step after reading the report. The stamp proves that one run passed on those inputs, not that the feature works.
