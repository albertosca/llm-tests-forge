"""promptfoo Python provider written by `forge emit`.

# Feature: classify-hiring-process-email

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

from moonlighter.core.llm import make_api_caller
from moonlighter.tracking.classification import classify_response

INPUTS = ["from", "subject", "body"]

STAGES = ["phone-screen", "technical", "onsite", "final"]


async def run_application(inputs: dict, model: str) -> dict:
    """Classify one email and report what the call cost.

    The feature's three inputs are moonlighter's three message fields, so the
    message is built from them directly; `from` becomes `from_` because `from`
    is a Python keyword and moonlighter names the key that way.

    moonlighter hands usage to no caller: `make_api_caller`'s `_call` passes the
    counts straight to `record_call`, which it imported into `moonlighter.core.llm`
    at module level. Because `_call` looks that name up in its module's globals on
    every call, rebinding it on the module object is seen by the call below, and
    the original is put back in `finally`. The rebinding is process-wide, so it
    holds only because promptfoo's Python worker runs one case at a time (`-j N`
    is N worker processes, not N calls in one) — see the shim's limitations in
    this example's README.
    """
    import moonlighter.core.llm as llm_module

    message = {
        "from_": inputs["from"],
        "subject": inputs["subject"],
        "body": inputs["body"],
    }
    model_id = model.split("/", 1)[1] if "/" in model else model
    captured = {"input_tokens": 0, "output_tokens": 0}
    original = llm_module.record_call

    def capturing_record_call(seconds, input_tokens=0, output_tokens=0):
        # A classification is one call today, but summing keeps the count right
        # if moonlighter ever retries or chains a second call behind this one.
        captured["input_tokens"] += input_tokens
        captured["output_tokens"] += output_tokens
        return original(seconds, input_tokens=input_tokens, output_tokens=output_tokens)

    llm_module.record_call = capturing_record_call
    try:
        result = await classify_response(message, STAGES, make_api_caller(), model_id)
    finally:
        llm_module.record_call = original
    return {"output": result, **captured}


async def call_api(prompt, options, context):
    inputs = {name: context["vars"].get(name, "") for name in INPUTS}
    model = (options.get("config") or {}).get("model") or "default"
    try:
        result = await run_application(inputs, model)
    except Exception as error:  # promptfoo shows this as an error row, not a failed assert
        return {"error": f"{type(error).__name__}: {error}"}
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
