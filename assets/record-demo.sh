#!/bin/sh
# Re-records assets/demo.gif. Runs the real commands against a scratch copy of
# an example (no model is called), so the checkout is never touched.
# Needs vhs (with ttyd and ffmpeg) and bun on the PATH.
set -eu

repository=$(cd "$(dirname "$0")/.." && pwd)
scratch=/tmp/forge-demo
rm -rf "$scratch"
mkdir "$scratch"
trap 'rm -rf "$scratch"' EXIT

cp -R "$repository/examples/moonlighter-classify-email" "$scratch/work"
mkdir "$scratch/bin"
printf '#!/bin/sh\nexec bun %s/src/cli/bin.ts "$@"\n' "$repository" > "$scratch/bin/llm-tests-forge"
chmod +x "$scratch/bin/llm-tests-forge"

# Two cases of the first scenario go back to pending, so the review has work.
python3 - "$scratch/work/.forge/cases" <<'PYTHON'
import glob, sys
path = sorted(glob.glob(sys.argv[1] + "/*.yaml"))[0]
parts = open(path).read().split("\n- id: ")
for index in (0, 1):
    parts[index] = parts[index].replace("status: approved", "status: pending", 1)
open(path, "w").write("\n- id: ".join(parts))
PYTHON

cd "$scratch/work"
PATH="$scratch/bin:$PATH" vhs -o "$repository/assets/demo.gif" "$repository/assets/demo.tape"
