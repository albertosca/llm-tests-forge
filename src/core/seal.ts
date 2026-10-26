import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";
import { ForgeError } from "./errors";
import type { Report } from "./report";
import type { StampBlock, Suite } from "./schemas";

/** Characters that make an `inputs` entry a glob rather than a path. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/** `format` is bumped when a stamp written by this version could not be read by another. */
export const STAMP_FORMAT = 1;

export const StampFileSchema = z.object({
	format: z.number(),
	sealedAt: z.string(),
	forgeVersion: z.string(),
	promptfooVersion: z.string().nullable(),
	ranAt: z.string().nullable(),
	models: z.object({
		targets: z.array(z.string()),
		judges: z.array(z.string()),
	}),
	inputs: z.record(z.string(), z.string()),
	inputsHash: z.string(),
	rows: z.number(),
	passRate: z.number(),
	minimumPassRate: z.number(),
	flaky: z.array(z.string()),
});

export type StampFile = z.infer<typeof StampFileSchema>;

function sha256(content: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** The file's hash, or why there is none: the entry names nothing readable as a file. */
async function fileHash(
	path: string,
): Promise<{ hash: string } | { problem: "does not exist" | "is not a file" }> {
	const status = await stat(path).catch(() => null);
	if (status === null) return { problem: "does not exist" };
	if (!status.isFile()) return { problem: "is not a file" };
	return { hash: sha256(await readFile(path)) };
}

/** The path as it is keyed in a stamp: relative to the base, with `/` on every platform. */
function keyOf(baseDirectory: string, path: string): string {
	return relative(baseDirectory, path).split(sep).join("/");
}

/**
 * The hash of every file the `inputs` entries name, keyed by path relative
 * to `baseDirectory` and sorted. An entry that names nothing is refused
 * rather than skipped: a stamp that silently hashes nothing watches nothing.
 * `lenient` is for `check`, which compares against a stamp and so reports an
 * input that is gone as a difference instead of refusing to run; an absolute
 * path is a mistake in the suite either way and is always refused.
 */
export async function resolveInputs(
	baseDirectory: string,
	patterns: string[],
	options: { lenient?: boolean } = {},
): Promise<Record<string, string>> {
	const paths = new Set<string>();
	for (const pattern of patterns) {
		if (isAbsolute(pattern) || win32.isAbsolute(pattern))
			throw new ForgeError(
				`stamp.inputs entry "${pattern}" is an absolute path; write it relative to the directory that holds .forge/`,
			);
		if (!GLOB_CHARACTERS.test(pattern)) {
			paths.add(resolve(baseDirectory, pattern));
			continue;
		}
		const matches: string[] = [];
		for await (const match of new Bun.Glob(pattern).scan({
			cwd: baseDirectory,
			onlyFiles: true,
		}))
			matches.push(match);
		if (matches.length === 0 && !options.lenient)
			throw new ForgeError(`stamp.inputs entry "${pattern}" matches no file`);
		for (const match of matches) paths.add(resolve(baseDirectory, match));
	}
	const hashes: Record<string, string> = {};
	for (const path of [...paths].sort()) {
		const key = keyOf(baseDirectory, path);
		const result = await fileHash(path);
		if ("hash" in result) hashes[key] = result.hash;
		else if (!options.lenient)
			throw new ForgeError(`stamp.inputs entry "${key}" ${result.problem}`, {
				file: path,
			});
	}
	return hashes;
}

/** One hash for the whole set: the sorted `path`, `hash` pairs, so a rename with the same content still changes it. */
export function inputsHashOf(hashes: Record<string, string>): string {
	const lines = Object.keys(hashes)
		.sort()
		.map((path) => `${path}\0${hashes[path]}\n`);
	return sha256(lines.join(""));
}

/** The suite's `stamp:` block, or the sentence that says what to write when it has none. */
export function requireStampBlock(suite: Suite): StampBlock {
	if (suite.stamp === undefined)
		throw new ForgeError(
			"suite.yaml has no stamp block; add stamp.inputs (the files whose change should invalidate a run) and stamp.minimum_pass_rate",
		);
	return suite.stamp;
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/**
 * Why this run cannot be sealed, empty when it can. A flaky pair does not
 * block: it passed on some repeat, and the stamp lists it. A pair that
 * failed or errored on every repeat does, as does a rate under the line
 * and a target model the run never exercised.
 */
export function sealRefusals(report: Report, suite: Suite): string[] {
	const refusals: string[] = [];
	for (const run of report.cases)
		if (["failing", "errored", "partly-errored"].includes(run.stability))
			refusals.push(`${run.case} @ ${run.model} is ${run.stability}`);
	const line = requireStampBlock(suite).minimum_pass_rate;
	if (report.passRate < line)
		refusals.push(
			`pass rate ${percent(report.passRate)} is under the line ${percent(line)}`,
		);
	const ran = new Set(report.cases.map((run) => run.model));
	for (const model of suite.target.models)
		if (!ran.has(model)) refusals.push(`the run has no row for ${model}`);
	return refusals;
}

const same = (left: string[], right: string[]): boolean =>
	left.length === right.length &&
	left.every((value, position) => value === right[position]);

/**
 * What `check` concludes: the reasons the stamp no longer describes the
 * repository, and the differences that only deserve a mention. A forge or
 * promptfoo version that moved warns and never fails, because whatever in
 * a new version changes the suite's behavior already shows in the inputs
 * and the models, which are compared.
 */
export function checkStamp(parameters: {
	stamp: StampFile;
	/** The hashes of the inputs as the suite resolves them now. */
	current: Record<string, string>;
	suite: Suite;
	versions: { forge: string; promptfoo: string | null };
}): { failures: string[]; warnings: string[] } {
	const { stamp, current, suite, versions } = parameters;
	const failures: string[] = [];
	const warnings: string[] = [];
	for (const [path, hash] of Object.entries(stamp.inputs)) {
		if (!(path in current)) failures.push(`${path} was sealed and is gone`);
		else if (current[path] !== hash)
			failures.push(`${path} changed since the stamp`);
	}
	for (const path of Object.keys(current))
		if (!(path in stamp.inputs))
			failures.push(`${path} is new since the stamp`);
	if (!same(stamp.models.targets, suite.target.models))
		failures.push(
			`target models changed: sealed ${stamp.models.targets.join(", ")}, now ${suite.target.models.join(", ")}`,
		);
	if (!same(stamp.models.judges, suite.judges))
		failures.push(
			`judges changed: sealed ${stamp.models.judges.join(", ")}, now ${suite.judges.join(", ")}`,
		);
	const line = requireStampBlock(suite).minimum_pass_rate;
	if (stamp.passRate < line)
		failures.push(
			`sealed pass rate ${percent(stamp.passRate)} is under the line ${percent(line)}`,
		);
	if (stamp.forgeVersion !== versions.forge)
		warnings.push(
			`sealed with llm-tests-forge ${stamp.forgeVersion}, this is ${versions.forge}`,
		);
	if (
		versions.promptfoo !== null &&
		stamp.promptfooVersion !== versions.promptfoo
	)
		warnings.push(
			`sealed from a promptfoo ${stamp.promptfooVersion ?? "of unknown version"} run, the last run here is ${versions.promptfoo}`,
		);
	return { failures, warnings };
}

/** The stamp for a run that `sealRefusals` let through. */
export function buildStamp(parameters: {
	report: Report;
	suite: Suite;
	hashes: Record<string, string>;
	forgeVersion: string;
	now: Date;
}): StampFile {
	const { report, suite, hashes, forgeVersion, now } = parameters;
	return {
		format: STAMP_FORMAT,
		sealedAt: now.toISOString(),
		forgeVersion,
		promptfooVersion: report.promptfooVersion,
		ranAt: report.ranAt,
		models: { targets: [...suite.target.models], judges: [...suite.judges] },
		inputs: hashes,
		inputsHash: inputsHashOf(hashes),
		rows: report.rows,
		passRate: report.passRate,
		minimumPassRate: requireStampBlock(suite).minimum_pass_rate,
		flaky: report.flaky,
	};
}
