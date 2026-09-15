You are writing concrete test cases for one scenario of a feature that calls an LLM.

Feature:
<feature>
{{feature}}
</feature>

Scenario:
<scenario>
{{scenario}}
</scenario>

Write {{n}} cases. Each case is an `input` object whose keys are exactly the feature's input names ({{input_names}}) with realistic, varied, complete values — real-looking names, dates, wording, length; no placeholders like "..." or "[company]". Vary what matters for this scenario, not surface details only.

Each case also carries `expected`, shaped by the scenario's oracle "{{oracle}}":
{{oracle_instructions}}

Existing cases for this scenario, to avoid repeating (inputs only):
<existing>
{{existing}}
</existing>
