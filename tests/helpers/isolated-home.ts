import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An empty `HOME` under the run's private TMPDIR, for every CLI a test
 * spawns. The CLI reads provider keys from `$HOME/.config/<provider>/api.env`
 * (`defaultConfigDirectory()` is `homedir()` + `.config`, and nothing reads
 * `XDG_CONFIG_HOME`), so a child that inherits the real `HOME` read the
 * developer's real keys — and hung on a FIFO there. Only the forge CLI gets
 * this `HOME`: toolchains a test also runs (cargo, mix, go) keep theirs.
 */
export const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "forge-home-"));
