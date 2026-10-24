/**
 * What a committed example report and its regeneration are allowed to differ
 * in, and the comparison itself. Kept apart from the script that reads
 * `examples/`, so it is tested on plain strings.
 *
 * One thing is excluded: the time the report was written (`generatedAt` in
 * report.json, the "Reported ..." line of report.md). Regenerating always
 * changes it. The time of the run (`ranAt`) is not excluded: it comes from
 * results.json. The baseline comparison is compared like the rest: an example
 * whose report has one commits the report it was compared with, as
 * baseline-report.json, and the regeneration passes it to `--baseline`.
 */

const REPORTED_LINE = /^Reported \S+\.$/;

/** report.json as pretty text, minus the field the comparison excludes. */
export function normalizeReportJson(text: string): string {
	const report = JSON.parse(text) as Record<string, unknown>;
	delete report.generatedAt;
	return JSON.stringify(report, null, 2);
}

/** report.md minus the line the comparison excludes. */
export function normalizeReportMarkdown(text: string): string {
	return text
		.split("\n")
		.filter((line) => !REPORTED_LINE.test(line))
		.join("\n");
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
