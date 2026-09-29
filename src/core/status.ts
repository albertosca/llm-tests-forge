import { access } from "node:fs/promises";
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
import { ReportSchema } from "./report";
import type { Case, Scenario } from "./schemas";
import { versionWarning } from "./version";

export type SuiteStatus =
	| { entry: string; state: "missing" }
	| { entry: string; state: "error"; error: string }
	| {
			entry: string;
			state: "ok";
			feature: string;
			scenarios: { approved: number; total: number };
			cases: { approved: number; pending: number };
			lastRun: { passRate: number; date: string } | null;
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
		scenarios: {
			approved: scenarios.filter(isReviewed).length,
			total: scenarios.length,
		},
		cases: {
			approved: cases.filter(isReviewed).length,
			pending: cases.filter((item) => item.status === "pending").length,
		},
		lastRun:
			report === null
				? null
				: { passRate: report.passRate, date: report.generatedAt.slice(0, 10) },
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
	try {
		return await readOk(entry, forgeDirectory, installed);
	} catch (error) {
		if (!(error instanceof ForgeError)) throw error;
		return { entry, state: "error", error: error.message };
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
			: `last run ${percent(status.lastRun.passRate)} (${status.lastRun.date})`;
	const line = `${status.entry}   ${status.feature}   ${status.scenarios.approved}/${status.scenarios.total} scenarios · ${status.cases.approved} approved, ${status.cases.pending} pending · ${run}`;
	// The ⚠ replaces the "warning: " prefix; the JSON keeps versionWarning's text as is.
	return status.warning === null
		? line
		: `${line}  ⚠ ${status.warning.replace(/^warning: /, "")}`;
}
