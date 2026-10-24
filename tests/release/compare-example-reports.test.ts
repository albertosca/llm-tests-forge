import { describe, expect, test } from "bun:test";
import {
	compareReports,
	firstDifference,
	normalizeReportJson,
	normalizeReportMarkdown,
} from "../../scripts/examples/compare";

const JSON_TEXT = `${JSON.stringify(
	{
		generatedAt: "2026-10-24T00:13:28.986Z",
		ranAt: "2026-09-30T16:27:10.834Z",
		rows: 2,
		baseline: { regressions: [{ case: "a" }] },
	},
	null,
	2,
)}\n`;

const MARKDOWN_TEXT = [
	"# llm-tests-forge report — run 2026-09-30T16:27:10.834Z",
	"Reported 2026-10-24T00:13:28.986Z.",
	"",
	"**Pass rate:** 50% · **flaky:** 0 · **regressions since baseline:** 6",
	"",
	"## Regressions since baseline",
	"",
	"| case | before | after |",
	"",
	"Fixed since baseline: 15.",
	"",
	"## Flaky cases",
	"",
	"No flaky case.",
].join("\n");

describe("normalizeReportJson", () => {
	test("drops the time the report was written and the baseline, keeps the run time", () => {
		const normalized = JSON.parse(normalizeReportJson(JSON_TEXT));
		expect(normalized).toEqual({
			ranAt: "2026-09-30T16:27:10.834Z",
			rows: 2,
		});
	});
});

describe("normalizeReportMarkdown", () => {
	test("drops the Reported line, the baseline figure and the baseline section, keeps the next section", () => {
		expect(normalizeReportMarkdown(MARKDOWN_TEXT)).toBe(
			[
				"# llm-tests-forge report — run 2026-09-30T16:27:10.834Z",
				"",
				"**Pass rate:** 50% · **flaky:** 0",
				"",
				"## Flaky cases",
				"",
				"No flaky case.",
			].join("\n"),
		);
	});

	test("keeps the run time in the header", () => {
		expect(normalizeReportMarkdown(MARKDOWN_TEXT)).toContain(
			"run 2026-09-30T16:27:10.834Z",
		);
	});
});

describe("firstDifference", () => {
	test("is null for equal texts", () => {
		expect(firstDifference("a\nb", "a\nb")).toBeNull();
	});

	test("names the first differing line, one-based, with both versions", () => {
		expect(firstDifference("a\nb\nc", "a\nx\ny")).toBe(
			'line 2: committed "b", regenerated "x"',
		);
	});

	test("names the end of the shorter text", () => {
		expect(firstDifference("a\nb", "a")).toBe(
			'line 2: committed "b", regenerated "<end of file>"',
		);
		expect(firstDifference("a", "a\nb")).toBe(
			'line 2: committed "<end of file>", regenerated "b"',
		);
	});
});

describe("compareReports", () => {
	const committed = { json: JSON_TEXT, markdown: MARKDOWN_TEXT };

	test("finds nothing when only the excluded fields differ", () => {
		const regenerated = {
			json: `${JSON.stringify(
				{
					generatedAt: "2027-01-01T00:00:00.000Z",
					ranAt: "2026-09-30T16:27:10.834Z",
					rows: 2,
					baseline: null,
				},
				null,
				2,
			)}\n`,
			markdown: MARKDOWN_TEXT.replace(
				"Reported 2026-10-24T00:13:28.986Z.",
				"Reported 2027-01-01T00:00:00.000Z.",
			),
		};
		expect(compareReports(committed, regenerated)).toEqual([]);
	});

	test("names report.json and its first differing line when a figure changes", () => {
		const regenerated = {
			...committed,
			json: JSON_TEXT.replace('"rows": 2', '"rows": 3'),
		};
		expect(compareReports(committed, regenerated)).toEqual([
			'report.json, line 3: committed "  \\"rows\\": 2", regenerated "  \\"rows\\": 3"',
		]);
	});

	test("names report.md when the run time in its header changes", () => {
		const regenerated = {
			...committed,
			markdown: MARKDOWN_TEXT.replace("2026-09-30", "2026-09-29"),
		};
		const [difference, ...others] = compareReports(committed, regenerated);
		expect(difference).toStartWith("report.md, line 1:");
		expect(others).toEqual([]);
	});

	test("reports both files when both differ", () => {
		const regenerated = {
			json: JSON_TEXT.replace('"rows": 2', '"rows": 3'),
			markdown: MARKDOWN_TEXT.replace("No flaky case.", "1 flaky case."),
		};
		expect(compareReports(committed, regenerated)).toHaveLength(2);
	});
});
