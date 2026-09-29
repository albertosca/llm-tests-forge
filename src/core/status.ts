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
import { versionWarning } from "./version";

/**
 * The shape `status --json` prints for each suite, kept stable for agents:
 * `featureStatus` is null when there is no feature.yaml yet; `scenarios`
 * counts approved (approved or edited), pending and rejected apart, so a
 * rejected scenario never counts towards what is left to review.
 */
export type SuiteStatus =
	| { entry: string; state: "missing" }
	| { entry: string; state: "error"; error: string }
	| {
			entry: string;
			state: "ok";
			feature: string;
			featureStatus: Feature["status"] | null;
			scenarios: { approved: number; pending: number; rejected: number };
			cases: { approved: number; pending: number };
			lastRun: { passRate: number; date: string | null } | null;
			warning: string | null;
	  };

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const isReviewed = (item: { status: Scenario["status"] }): boolean =>
	item.status === "approved" || item.status === "edited";

/** Display text only: the JSON carries null for an unknown date. */
const UNKNOWN_DATE = "unknown date";

async function readOk(
	entry: string,
	forgeDirectory: string,
	installed: string,
): Promise<SuiteStatus> {
	const feature = await readFeatureIfPresent(forgeDirectory);
	const scenarios = await readScenarios(forgeDirectory);
	const cases: Case[] = [
		...(await readAllCases(forgeDirectory)).values(),
	].flat();
	const present = await readSuiteIfPresent(forgeDirectory);
	const reportPath = forgePaths(forgeDirectory).reportJson;
	const report = (await exists(reportPath))
		? await readYamlFile(reportPath, ReportSchema)
		: null;
	return {
		entry,
		state: "ok",
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
		// A parser's message spans lines (it quotes the source); status is one line per suite.
		return {
			entry,
			state: "error",
			error: error.message.replace(/\s*\n\s*/g, " ").trim(),
		};
	}
}

const percent = (passRate: number): string => `${(passRate * 100).toFixed(1)}%`;

/** One line, columns separated by three spaces (not padded to a width). */
export function renderStatusLine(status: SuiteStatus): string {
	if (status.state === "missing") return `${status.entry}   missing`;
	if (status.state === "error")
		return `${status.entry}   error: ${status.error}`;
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
	const line = `${status.entry}   ${feature}   ${scenarios} · ${cases} · ${run}`;
	// The ⚠ replaces the "warning: " prefix; the JSON keeps versionWarning's text as is.
	return status.warning === null
		? line
		: `${line}  ⚠ ${status.warning.replace(/^warning: /, "")}`;
}
