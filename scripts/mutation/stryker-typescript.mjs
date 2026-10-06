// Registers stryker-typescript-resolve.mjs (which says why) in a Node
// process. The `mutation` script loads this file with `node --import`, and
// stryker.config.mjs passes it to the checker's processes through
// `checkerNodeArgs`. Bun has no `module.registerHooks`, so the hook itself
// lives in its own file, where `bun test` can call it.
import { registerHooks } from "node:module";
import { resolveForStryker } from "./stryker-typescript-resolve.mjs";

registerHooks({ resolve: resolveForStryker });
