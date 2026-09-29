/**
 * Preloaded by every bunfig file, before any test module is imported: gives
 * the whole test process one private temporary directory and removes it at
 * the end of the run. `bun test` never emits `process.on("exit")` (measured on
 * bun 1.4.2), so the removal hangs on the preload's own `afterAll`, which runs
 * once after the last file; the exit handler stays for any other runner.
 */
import { afterAll } from "bun:test";
import { createTemporaryRoot } from "./temporary-root";

const removeRunRoot = createTemporaryRoot();
afterAll(removeRunRoot);
process.on("exit", removeRunRoot);
