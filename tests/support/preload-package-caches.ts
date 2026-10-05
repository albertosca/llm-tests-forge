/**
 * Preloaded by `bunfig.packages.toml` only, after the temporary root: keeps
 * the package tests (and every child they spawn, which inherits this
 * environment) out of `~/.npm` and `~/.cache/uv`. npm's cache goes under the
 * run's private TMPDIR and away with it. uv's goes to the repository's
 * `node_modules/.cache/forge-uv` (gitignored with node_modules/) and stays
 * there across runs, so the wheel builds do not download hatchling on every
 * run.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPOSITORY } from "../helpers/repository";

process.env.npm_config_cache = join(tmpdir(), "npm-cache");
process.env.UV_CACHE_DIR = join(REPOSITORY, "node_modules/.cache/forge-uv");
