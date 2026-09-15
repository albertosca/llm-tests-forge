You are enumerating test scenarios for one feature of an application that calls an LLM. A scenario is a class of situations the feature must handle, not a single input.

Feature:
<feature>
{{feature}}
</feature>

Produce {{count}} scenarios{{coverage}}. Each scenario has:
- `id`: kebab-case, at most five words, unique.
- `kind`: one of happy, edge, ambiguous, out_of_scope, adversarial, language.
  - happy: the common, well-formed situations the feature exists for.
  - edge: well-formed but unusual — very long, very short, empty fields, unusual formatting.
  - ambiguous: situations where two answers are defensible and the invariants decide.
  - out_of_scope: inputs the feature is not meant to handle and must answer conservatively.
  - adversarial: inputs that try to make the feature ignore its instructions or leak them.
  - language: the same situations in a language other than the one the description assumes.
- `oracle`: how a case in this scenario is checked — `label` when the feature's output has a closed set of labels and this scenario has one correct label; `fields` when specific output fields have a checkable value; `rubric` when only a judgement sentence can check it.
- `description`: one sentence describing the class of situation, concrete enough that another person could write inputs for it.

Already existing scenarios (do not repeat them, complement them):
<existing>
{{existing}}
</existing>
