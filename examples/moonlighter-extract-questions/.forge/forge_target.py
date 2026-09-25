"""promptfoo Python provider written by `forge emit`.

# Feature: extract-job-application-questions

promptfoo calls `call_api` once per test case and per target model. `context["vars"]`
holds the case's inputs; `options["config"]["model"]` is the model this provider
entry was emitted for. Return {"output": <string>} — the asserts in
promptfooconfig.yaml parse it — or {"error": <string>} when the application
failed. If you can, also return "tokenUsage": promptfoo keeps it on each result,
and `forge report` prices those tokens from prices.yaml and compares the bill
with the estimate.

Fill in `run_application`. Everything else can stay as it is. This file is
written once and never overwritten by `forge emit`.
"""

import json

from moonlighter.application.assisted.sources.pasted import extract_questions_from_page
from moonlighter.core.llm import make_caller

INPUTS = ["page"]


async def run_application(inputs: dict, model: str) -> dict:
    """Extract the questions from one copied page and report what the call cost.

    The output is the function's own result, not the model's raw JSON: the
    application post-processes it (`_kind` turns a choice kind with no options
    into `long_text`, options are kept only for choice kinds), and that is what
    the rest of moonlighter consumes. Each question is written with its keys in
    the dataclass order — label, kind, required, options — because the fields
    assert compares values as JSON text, where key order counts.

    Token usage is captured the way the first example does it, for when the
    `api` backend is used: its `_call` looks `record_call` up in its module's globals
    on every call, so rebinding it on the module object is seen by the call
    below, and the original is put back in `finally`. The rebinding is
    process-wide, which holds because promptfoo's Python worker runs one case
    at a time.
    """
    import moonlighter.core.llm as llm_module

    model_id = model.split("/", 1)[1] if "/" in model else model
    captured = {"input_tokens": 0, "output_tokens": 0}
    original = llm_module.record_call

    def capturing_record_call(seconds, input_tokens=0, output_tokens=0):
        captured["input_tokens"] += input_tokens
        captured["output_tokens"] += output_tokens
        return original(seconds, input_tokens=input_tokens, output_tokens=output_tokens)

    llm_module.record_call = capturing_record_call
    try:
        # The `cli` backend is moonlighter's production default: `claude -p` on
        # the logged-in Claude subscription, no API key. It ignores `model_id`
        # (the CLI answers with the session's model) and reports no tokens.
        questions = await extract_questions_from_page(
            inputs["page"], make_caller({"llm_backend": "cli"}), model_id
        )
    finally:
        llm_module.record_call = original
    output = {
        "questions": [
            {
                "label": question.label,
                "kind": str(question.kind),
                "required": question.required,
                "options": list(question.options),
            }
            for question in questions
        ]
    }
    return {"output": output, **captured}


async def call_api(prompt, options, context):
    inputs = {name: context["vars"].get(name, "") for name in INPUTS}
    model = (options.get("config") or {}).get("model") or "default"
    try:
        result = await run_application(inputs, model)
    except Exception as e:  # promptfoo shows this as an error row, not a failed assert
        return {"error": f"{type(e).__name__}: {e}"}
    output = result["output"]
    if not isinstance(output, str):
        output = json.dumps(output)
    prompt_tokens = int(result.get("input_tokens", 0))
    completion_tokens = int(result.get("output_tokens", 0))
    return {
        "output": output,
        "tokenUsage": {
            "prompt": prompt_tokens,
            "completion": completion_tokens,
            "total": prompt_tokens + completion_tokens,
        },
    }
