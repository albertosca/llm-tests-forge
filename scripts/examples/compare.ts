/**
 * What a committed example report and its regeneration are allowed to differ
 * in, and the comparison itself. Kept apart from the script that reads
 * `examples/`, so it is tested on plain strings.
 *
 * Two things are excluded, and only these two:
 *
 * - The time the report was written (`generatedAt` in report.json, the
 *   "Reported ..." line of report.md). Regenerating always changes it. The
 *   time of the run (`ranAt`) is not excluded: it comes from results.json.
 * - The baseline comparison (`baseline` in report.json, the "regressions
 *   since baseline" figure and the "Regressions since baseline" section of
 *   report.md). A committed report may have been produced with
 *   `--baseline` against an earlier report.json that was never committed,
 *   so the comparison cannot be reproduced. Everything else the baseline
 *   does not touch is still compared.
 */

const REPORTED_LINE = /^Reported \S+\.$/;
const BASELINE_FIGURE = / · \*\*regressions since baseline:\*\* \d+/;
const BASELINE_HEADING = "## Regressions since baseline";

/** report.json as pretty text, minus the fields the comparison excludes. */
export function normalizeReportJson(text: string): string {
	const report = JSON.parse(text) as Record<string, unknown>;
	delete report.generatedAt;
	delete report.baseline;
	return JSON.stringify(report, null, 2);
}

/** report.md minus the lines and the section the comparison excludes. */
export function normalizeReportMarkdown(text: string): string {
	const kept: string[] = [];
	let insideBaselineSection = false;
	for (const line of text.split("\n")) {
		if (line === BASELINE_HEADING) {
			insideBaselineSection = true;
			continue;
		}
		if (insideBaselineSection && line.startsWith("## "))
			insideBaselineSection = false;
		if (insideBaselineSection || REPORTED_LINE.test(line)) continue;
		kept.push(line.replace(BASELINE_FIGURE, ""));
	}
	return kept.join("\n");
}

/** The first line where the two texts differ, described; null when they match. */
export function firstDifference(
	committed: string,
	regenerated: string,
): string | null {
	const committedLines = committed.split("\n");
	const regeneratedLines = regenerated.split("\n");
	const length = Math.max(committedLines.length, regeneratedLines.length);
	for (let index = 0; index < length; index += 1) {
		const committedLine = committedLines[index] ?? "<end of file>";
		const regeneratedLine = regeneratedLines[index] ?? "<end of file>";
		if (committedLine !== regeneratedLine)
			return `line ${index + 1}: committed ${JSON.stringify(committedLine)}, regenerated ${JSON.stringify(regeneratedLine)}`;
	}
	return null;
}

/** One report's two files, as text. */
export interface ReportTexts {
	json: string;
	markdown: string;
}

/**
 * The differences between a committed report and its regeneration, one
 * message per file that differs, each naming the file and the first
 * differing line. Empty when they match.
 */
export function compareReports(
	committed: ReportTexts,
	regenerated: ReportTexts,
): string[] {
	const differences: string[] = [];
	const jsonDifference = firstDifference(
		normalizeReportJson(committed.json),
		normalizeReportJson(regenerated.json),
	);
	if (jsonDifference) differences.push(`report.json, ${jsonDifference}`);
	const markdownDifference = firstDifference(
		normalizeReportMarkdown(committed.markdown),
		normalizeReportMarkdown(regenerated.markdown),
	);
	if (markdownDifference) differences.push(`report.md, ${markdownDifference}`);
	return differences;
}
