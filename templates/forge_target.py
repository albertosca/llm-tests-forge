"""promptfoo Python provider written by `forge emit`.

# Feature: {{feature_id}}

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

INPUTS = {{input_names}}


async def run_application(inputs: dict, model: str) -> dict:
    """Call the real application and return {"output": str, "input_tokens": int, "output_tokens": int}.

    `inputs` has one key per name in INPUTS. Import your own code here; run
    promptfoo with a `pythonExecutable` (suite.yaml: target.python) that can
    import it. Token counts are optional; return 0 when you do not have them.
    """
    raise NotImplementedError("edit forge_target.py: call your application here")


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
