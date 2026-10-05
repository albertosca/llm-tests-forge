import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "./errors";
import {
	forgePaths,
	readAllCases,
	readFeatureIfPresent,
	readScenarios,
	readSuiteIfPresent,
	readYamlFile,
} from "./files";
import { isoDay, ReportSchema } from "./report";
import type { Case, Feature, Scenario } from "./schemas";
import { selectCases } from "./select";
import { versionWarning } from "./version";

/**
 * What a suite that reads holds: `featureStatus` is null when there is no
 * feature.yaml yet; `scenarios` counts approved (approved or edited),
 * pending and rejected apart, so a rejected scenario never counts towards
 * what is left to review.
 */
interface SuiteSummary {
	feature: string;
	featureStatus: Feature["status"] | null;
	scenarios: { approved: number; pending: number; rejected: number };
	cases: { approved: number; pending: number };
	lastRun: { passRate: number; date: string | null } | null;
	warning: string | null;
}

/**
 * The shape `status --json` prints for each suite, kept stable for agents:
 * `entry` then `state` lead every row. An error row of a suite that reads
 * but that emit would refuse keeps the summary, so the person loses no
 * context; one that does not read has the message alone.
 */
export type SuiteStatus =
	| { entry: string; state: "missing" }
	| { entry: string; state: "error"; error: string }
	| ({ entry: string; state: "ok" } & SuiteSummary)
	| ({ entry: string; state: "error"; error: string } & SuiteSummary);

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		// Stryker disable next-line ArrowFunction: a handler returning undefined instead of false is read exactly as false by both callers (a negated check and a ternary)
		() => false,
	);
}

const isReviewed = (item: { status: Scenario["status"] }): boolean =>
	item.status === "approved" || item.status === "edited";

/** Display text only: the JSON carries null for an unknown date. */
const UNKNOWN_DATE = "unknown date";

/** A ForgeError's message on one line: a parser's message spans lines (it quotes the source), and status is one line per suite. */
function oneLine(error: ForgeError): string {
	// Stryker disable next-line MethodExpression: every ForgeError readOk can raise (files.ts's readers, selectCases) opens with fixed wording and closes with the "(file: …)" suffix ForgeError adds, so there is no edge whitespace for trim to remove; the status test "every failure readOk can raise…" guards it
	return error.message.replace(/\s*\n\s*/g, " ").trim();
}

async function readOk(
	entry: string,
	forgeDirectory: string,
	installed: string,
): Promise<SuiteStatus> {
	const feature = await readFeatureIfPresent(forgeDirectory);
	const scenarios = await readScenarios(forgeDirectory);
	const casesByScenario = await readAllCases(forgeDirectory);
	const cases: Case[] = [...casesByScenario.values()].flat();
	const present = await readSuiteIfPresent(forgeDirectory);
	const paths = forgePaths(forgeDirectory);
	const report = (await exists(paths.reportJson))
		? await readYamlFile(paths.reportJson, ReportSchema)
		: null;
	const summary: SuiteSummary = {
		feature: feature?.id ?? "(no feature yet)",
		featureStatus: feature?.status ?? null,
		scenarios: {
			approved: scenarios.filter(isReviewed).length,
			pending: scenarios.filter((item) => item.status === "pending").length,
			rejected: scenarios.filter((item) => item.status === "rejected").length,
		},
		cases: {
			approved: cases.filter(isReviewed).length,
			pending: cases.filter((item) => item.status === "pending").length,
		},
		lastRun:
			report === null
				? null
				: {
						passRate: report.passRate,
						date: isoDay(report.ranAt ?? report.generatedAt),
					},
		warning: versionWarning(present?.suite.forge_version, installed),
	};
	// The selection emit, estimate and report would make, for its refusals
	// alone (a case whose input keys are not the feature's inputs, an
	// include naming no scenario): a suite they refuse is never shown as ok.
	// Its blockers are what the counts already show as pending.
	if (feature !== undefined && present !== null)
		try {
			selectCases({
				suite: present.suite,
				scenarios,
				casesByScenario,
				paths,
				feature,
			});
		} catch (error) {
			if (!(error instanceof ForgeError)) throw error;
			return { entry, state: "error", error: oneLine(error), ...summary };
		}
	return { entry, state: "ok", ...summary };
}

/**
 * What `status` shows for one registered suite. A suite that cannot be read
 * is a state, not an exception: one broken suite must not hide the others.
 * Anything but a ForgeError is a bug and still propagates.
 */
export async function suiteStatus(
	entry: string,
	directory: string,
	installed: string,
): Promise<SuiteStatus> {
	const forgeDirectory = join(directory, ".forge");
	if (!(await exists(forgeDirectory))) return { entry, state: "missing" };
	if (!(await stat(forgeDirectory)).isDirectory())
		return {
			entry,
			state: "error",
			error: `${forgeDirectory} is a file, not a directory`,
		};
	try {
		return await readOk(entry, forgeDirectory, installed);
	} catch (error) {
		if (!(error instanceof ForgeError)) throw error;
		return { entry, state: "error", error: oneLine(error) };
	}
}

const percent = (passRate: number): string => `${(passRate * 100).toFixed(1)}%`;

/** One line, columns separated by three spaces (not padded to a width). */
export function renderStatusLine(status: SuiteStatus): string {
	if (status.state === "missing") return `${status.entry}   missing`;
	if (!("feature" in status)) return `${status.entry}   error: ${status.error}`;
	const run =
		status.lastRun === null
			? "no run yet"
			: `last run ${percent(status.lastRun.passRate)} (${status.lastRun.date ?? UNKNOWN_DATE})`;
	const feature =
		status.featureStatus === "pending"
			? `${status.feature} (feature pending)`
			: status.feature;
	const rejected =
		status.scenarios.rejected > 0
			? `, ${status.scenarios.rejected} rejected`
			: "";
	const scenarios = `${status.scenarios.approved} scenarios approved, ${status.scenarios.pending} pending${rejected}`;
	const cases = `${status.cases.approved} cases approved, ${status.cases.pending} pending`;
	const counts = `${status.entry}   ${feature}   ${scenarios} · ${cases} · ${run}`;
	const line =
		status.state === "error" ? `${counts}   error: ${status.error}` : counts;
	// The ⚠ replaces the "warning: " prefix; the JSON keeps versionWarning's text as is.
	if (status.warning === null) return line;
	// Stryker disable next-line Regex: both of versionWarning's sentences start with "warning: " (the version test "each warning starts with…" guards it), so the first occurrence is always at the start and dropping the anchor replaces the same text
	return `${line}  ⚠ ${status.warning.replace(/^warning: /, "")}`;
}
