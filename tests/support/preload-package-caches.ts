/**
 * Preloaded by `bunfig.packages.toml` only, after the temporary root: points
 * npm's and uv's caches under the run's private TMPDIR, so the package tests
 * (and every child they spawn, which inherits this environment) leave nothing
 * in `~/.npm` or `~/.cache/uv`. The directory goes away with the run root.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.npm_config_cache = join(tmpdir(), "npm-cache");
process.env.UV_CACHE_DIR = join(tmpdir(), "uv-cache");
