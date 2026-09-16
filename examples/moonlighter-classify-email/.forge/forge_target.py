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

INPUTS = ["email"]

STAGES = ["phone-screen", "technical", "onsite", "final"]


def parse_email(text: str) -> tuple[str, str, str]:
    """Split the forge's single `email` input into moonlighter's (from_, subject, body).

    The cases are written in two shapes: a `From:`/`Subject:` header block followed
    by a blank line and the body, and the same block with the body's first line
    carried on a `Body:` marker line. Splitting on the first blank line handles
    neither: it swallows the `Body:` line into the header, and a case with no blank
    line at all comes out with an empty body.
    """
    lines = text.splitlines()
    from_ = ""
    subject = ""
    i = 0
    # Leading headers, in whatever order they appear. An empty `Subject:` is valid.
    while i < len(lines):
        line = lines[i]
        if line.startswith("From:"):
            from_ = line[len("From:") :].strip()
        elif line.startswith("Subject:"):
            subject = line[len("Subject:") :].strip()
        else:
            break
        i += 1
    # Any blank lines between the headers and the body belong to neither.
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    rest = lines[i:]
    # A `Body:` marker is punctuation, not content: drop it and keep the rest of its line.
    if rest and rest[0].startswith("Body:"):
        first = rest[0][len("Body:") :].strip()
        rest = ([first] if first else []) + rest[1:]
    return from_, subject, "\n".join(rest).strip()


async def run_application(inputs: dict, model: str) -> dict:
    from_, subject, body = parse_email(inputs["email"])
    message = {"from_": from_, "subject": subject, "body": body}
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
