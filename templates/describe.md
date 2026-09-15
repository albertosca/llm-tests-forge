You are helping a developer write a regression test suite for one feature of their application that calls an LLM.

Below is the developer's own description of the feature, and optionally the real prompt the application sends. Normalise them into the structured form requested by the schema. Do not invent capabilities the description does not state. When the description names a closed set of possible answers (labels, categories, decisions), list them exactly as written, in the order given. When the real prompt states rules ("answer only with JSON", "never do X"), copy each rule as one invariant in the developer's words. Keep `purpose` to one sentence.

The `id` must be kebab-case, at most five words, derived from the purpose.

Developer's description:
<description>
{{description}}
</description>

Real prompt sent by the application (may be empty):
<prompt>
{{prompt}}
</prompt>
