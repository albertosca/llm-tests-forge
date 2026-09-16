"""promptfoo Python provider written by `forge emit`.

# Feature: classify-hiring-process-email

promptfoo calls `call_api` once per test case and per target model. `context["vars"]`
holds the case's inputs; `options["config"]["model"]` is the model this provider
entry was emitted for. Return {"output": <string>} — the asserts in
promptfooconfig.yaml parse it — or {"error": <string>} when the application
failed. If you can, also return "tokenUsage" and "cost" (see below): promptfoo
keeps them on each result, and `forge report` compares them with the estimate.

Fill in `run_application`. Everything else can stay as it is. This file is
written once and never overwritten by `forge emit`.
"""

import json

from moonlighter.core.llm import make_api_caller
from moonlighter.tracking.classification import classify_response

INPUTS = ["email"]

STAGES = ["phone-screen", "technical", "onsite", "final"]


async def run_application(inputs: dict, model: str) -> dict:
    email = inputs["email"]
    # The forge's single `email` input carries "From: …\nSubject: …\n\n…"; split it back into moonlighter's message dict.
    head, _, body = email.partition("\n\n")
    fields = dict(line.split(": ", 1) for line in head.splitlines() if ": " in line)
    message = {"from_": fields.get("From", ""), "subject": fields.get("Subject", ""), "body": body}
    model_id = model.split("/", 1)[1] if "/" in model else model
    result = await classify_response(message, STAGES, make_api_caller(), model_id)
    return {"output": result, "input_tokens": 0, "output_tokens": 0}


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
