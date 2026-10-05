import { describe, expect, spyOn, test } from "bun:test";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import * as files from "../../src/core/files";
import { stampSuite } from "../../src/core/files";
import * as select from "../../src/core/select";
import { renderStatusLine, suiteStatus } from "../../src/core/status";
import { FORGE_VERSION } from "../../src/core/version";
import { fixturePath, REPOSITORY } from "../helpers/repository";

// A frozen copy of the extract-questions example, so curating the living
// example under examples/ never changes the counts these tests pin.
const FIXTURE = fixturePath("extract-questions/.forge");

/** A project directory holding a copy of the fixture suite at `evals/<name>`. */
async function suiteCopy(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-status-"));
	const directory = join(root, "evals", name);
	await mkdir(directory, { recursive: true });
	await cp(FIXTURE, join(directory, ".forge"), { recursive: true });
	// The fixture is frozen at the version that wrote it; a suite the installed
	// forge wrote itself carries the installed version, whatever that is.
	await stampSuite(join(directory, ".forge"), FORGE_VERSION);
	return directory;
}

describe("suiteStatus and renderStatusLine", () => {
	test("renders the fixture suite as one line with its counts and last run", async () => {
		const directory = await suiteCopy("a");
		const report = JSON.parse(
			await readFile(join(directory, ".forge", "report.json"), "utf8"),
		);
		expect(report.ranAt).toBe("2026-09-25T14:48:00.200Z");
		const date = report.ranAt.slice(0, 10);
		const status = await suiteStatus("evals/a", directory, FORGE_VERSION);
		expect(renderStatusLine(status)).toBe(
			`evals/a   extract-job-application-questions   14 scenarios approved, 0 pending · 42 cases approved, 0 pending · last run 67.9% (${date})`,
		);
		expect(status).toEqual({
			entry: "evals/a",
			state: "ok",
			feature: "extract-job-application-questions",
			featureStatus: "approved",
			scenarios: { approved: 14, pending: 0, rejected: 0 },
			cases: { approved: 42, pending: 0 },
			lastRun: { passRate: 0.6786, date },
			warning: null,
		});
	});

	test("counts edited cases as approved, pending ones as pending, and rejected ones as neither", async () => {
		const directory = await suiteCopy("counts");
		const casesFile = join(
			directory,
			".forge",
			"cases",
			"standard-multi-field-form.yaml",
		);
		const text = await readFile(casesFile, "utf8");
		const replacements = [
			"  status: edited",
			"  status: pending",
			"  status: rejected",
		];
		const rewritten = text.replace(
			/^ {2}status: approved$/gm,
			() => replacements.shift() ?? "  status: approved",
		);
		expect(replacements).toEqual([]);
		await writeFile(casesFile, rewritten);
		const status = await suiteStatus("evals/counts", directory, FORGE_VERSION);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		expect(status.cases).toEqual({ approved: 40, pending: 1 });
	});

	test("counts edited scenarios as approved, pending ones as pending, and rejected ones apart, outside the total", async () => {
		const directory = await suiteCopy("scenario-counts");
		const scenariosFile = join(directory, ".forge", "scenarios.yaml");
		const scenarios = parse(await readFile(scenariosFile, "utf8"));
		const statuses = ["edited", "pending", "rejected"];
		for (const [position, status] of statuses.entries())
			scenarios[position].status = status;
		await writeFile(scenariosFile, stringify(scenarios));
		const status = await suiteStatus(
			"evals/scenario-counts",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		expect(status.scenarios).toEqual({ approved: 12, pending: 1, rejected: 1 });
		expect(renderStatusLine(status)).toContain(
			"   12 scenarios approved, 1 pending, 1 rejected · 42 cases approved",
		);
	});

	test("a feature waiting for review is named as pending on the line and in featureStatus", async () => {
		const directory = await suiteCopy("feature-pending");
		const featureFile = join(directory, ".forge", "feature.yaml");
		await writeFile(
			featureFile,
			(await readFile(featureFile, "utf8")).replace(
				/^status: approved$/m,
				"status: pending",
			),
		);
		const status = await suiteStatus(
			"evals/feature-pending",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		expect(status.featureStatus).toBe("pending");
		expect(renderStatusLine(status)).toStartWith(
			"evals/feature-pending   extract-job-application-questions (feature pending)   14 scenarios approved",
		);
	});

	test("an edited feature is shown by its id alone, like an approved one", async () => {
		const directory = await suiteCopy("feature-edited");
		const featureFile = join(directory, ".forge", "feature.yaml");
		await writeFile(
			featureFile,
			(await readFile(featureFile, "utf8")).replace(
				/^status: approved$/m,
				"status: edited",
			),
		);
		const status = await suiteStatus(
			"evals/feature-edited",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		expect(status.featureStatus).toBe("edited");
		expect(renderStatusLine(status)).toStartWith(
			"evals/feature-edited   extract-job-application-questions   14 scenarios approved",
		);
	});

	test("a .forge that is a plain file is an error naming it, not an ok suite", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-status-"));
		await writeFile(join(root, ".forge"), "not a directory\n");
		const status = await suiteStatus(".", root, FORGE_VERSION);
		expect(status).toEqual({
			entry: ".",
			state: "error",
			error: `${join(root, ".forge")} is a file, not a directory`,
		});
	});

	test("shows a suite with case files but no feature.yaml as no feature yet, counting its cases", async () => {
		const directory = await suiteCopy("no-feature");
		await unlink(join(directory, ".forge", "feature.yaml"));
		const status = await suiteStatus(
			"evals/no-feature",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		expect(status.feature).toBe("(no feature yet)");
		expect(status.cases).toEqual({ approved: 42, pending: 0 });
	});

	test("puts the version warning after two spaces and a warning sign", async () => {
		const directory = await suiteCopy("old");
		const suiteFile = join(directory, ".forge", "suite.yaml");
		await writeFile(
			suiteFile,
			(await readFile(suiteFile, "utf8")).replace(
				/^forge_version: .*$/m,
				"forge_version: 0.0.1",
			),
		);
		const line = renderStatusLine(
			await suiteStatus("evals/old", directory, FORGE_VERSION),
		);
		expect(line).toEndWith(
			`  ⚠ this suite was written by llm-tests-forge 0.0.1; installed is ${FORGE_VERSION}`,
		);
	});

	test("renders a suite whose directory is gone as missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-status-"));
		const status = await suiteStatus(
			"evals/gone",
			join(root, "evals", "gone"),
			FORGE_VERSION,
		);
		expect(status).toEqual({ entry: "evals/gone", state: "missing" });
		expect(renderStatusLine(status)).toBe("evals/gone   missing");
	});

	test("renders a suite whose scenarios.yaml does not parse as an error with the parser's message", async () => {
		const directory = await suiteCopy("bad");
		const scenariosFile = join(directory, ".forge", "scenarios.yaml");
		await writeFile(scenariosFile, "- id: [unclosed\n");
		const line = renderStatusLine(
			await suiteStatus("evals/bad", directory, FORGE_VERSION),
		);
		expect(line).toStartWith("evals/bad   error: invalid YAML: ");
		expect(line).toContain(scenariosFile);
	});

	test("an error whose message spans lines is joined into the suite's one line", async () => {
		const directory = await suiteCopy("multiline");
		const scenariosFile = join(directory, ".forge", "scenarios.yaml");
		// The YAML parser's message quotes the source line and a caret under it.
		await writeFile(scenariosFile, "- id: [unclosed\n");
		const status = await suiteStatus(
			"evals/multiline",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "error") throw new Error("expected an error suite");
		expect(status.error).not.toContain("\n");
		expect(status.error).toContain(scenariosFile);
	});

	test("each line break of a multi-line message, with the indentation around it, reads as one space", async () => {
		const directory = await suiteCopy("indented");
		const scenariosFile = join(directory, ".forge", "scenarios.yaml");
		// The parser quotes the offending line with its two-space indent,
		// between blank lines, and puts a caret under it.
		await writeFile(scenariosFile, "- id: a\n  description: [unclosed\n");
		const status = await suiteStatus(
			"evals/indented",
			directory,
			FORGE_VERSION,
		);
		if (status.state !== "error") throw new Error("expected an error suite");
		// The parser's own wording is yaml's to change; what status owns is
		// one line, single spaces, and the quoted source kept in it.
		expect(status.error).toStartWith("invalid YAML: ");
		expect(status.error).toEndWith(`(file: ${scenariosFile})`);
		expect(status.error).not.toContain("\n");
		expect(status.error).not.toContain("  ");
		expect(status.error).toContain(" description: [unclosed ^ ");
	});

	test("every failure readOk can raise ends with the file its reader or selectCases names, so the message has no edge whitespace to trim", async () => {
		const broken: Record<string, string> = {
			"feature.yaml": "id: [unclosed\n",
			"scenarios.yaml": "- id: [unclosed\n",
			"cases/broken.yaml": "- id: [unclosed\n",
			"suite.yaml": "target: [unclosed\n",
			"report.json": "{ not json\n",
		};
		for (const [name, text] of Object.entries(broken)) {
			const directory = await suiteCopy("edges");
			const path = join(directory, ".forge", name);
			await writeFile(path, text);
			const status = await suiteStatus("evals/edges", directory, FORGE_VERSION);
			if (status.state !== "error")
				throw new Error(`expected an error suite for ${name}`);
			expect(status.error).toEndWith(`(file: ${path})`);
			expect(status.error).toBe(status.error.trim());
		}
		// selectCases' refusals name the file and the item.
		const refused = [
			await suiteWithRenamedKey("edges-keys", "approved"),
			await suiteWithMissingInclude("edges-include"),
		];
		for (const { directory } of refused) {
			const status = await suiteStatus("evals/edges", directory, FORGE_VERSION);
			if (status.state !== "error")
				throw new Error(`expected an error suite for ${directory}`);
			expect(status.error).toMatch(/\(file: [^)]+, id: [^)]+\)$/);
			expect(status.error).toBe(status.error.trim());
		}
	});

	test("a failure that is not a ForgeError is a bug, and propagates rather than showing as a broken suite", async () => {
		const directory = await suiteCopy("bug");
		const reader = spyOn(files, "readScenarios").mockImplementation(
			async () => {
				throw new TypeError("a bug in the reader");
			},
		);
		try {
			await expect(
				suiteStatus("evals/bug", directory, FORGE_VERSION),
			).rejects.toThrow(new TypeError("a bug in the reader"));
		} finally {
			reader.mockRestore();
		}
	});

	test("a failure in selectCases that is not a ForgeError is a bug too, and propagates", async () => {
		const directory = await suiteCopy("selectbug");
		const selection = spyOn(select, "selectCases").mockImplementation(() => {
			throw new TypeError("a bug in the selection");
		});
		try {
			await expect(
				suiteStatus("evals/selectbug", directory, FORGE_VERSION),
			).rejects.toThrow(new TypeError("a bug in the selection"));
		} finally {
			selection.mockRestore();
		}
	});

	test("renders a suite with no feature.yaml yet as ok with no feature and zero counts", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-status-"));
		await mkdir(join(root, ".forge"));
		const status = await suiteStatus(".", root, FORGE_VERSION);
		expect(status).toEqual({
			entry: ".",
			state: "ok",
			feature: "(no feature yet)",
			featureStatus: null,
			scenarios: { approved: 0, pending: 0, rejected: 0 },
			cases: { approved: 0, pending: 0 },
			lastRun: null,
			warning: null,
		});
		expect(renderStatusLine(status)).toBe(
			".   (no feature yet)   0 scenarios approved, 0 pending · 0 cases approved, 0 pending · no run yet",
		);
	});

	/** The suite copy with its report.json's two dates rewritten. */
	async function suiteWithDates(
		name: string,
		dates: { ranAt?: string | null; generatedAt: string },
	): Promise<string> {
		const directory = await suiteCopy(name);
		const reportFile = join(directory, ".forge", "report.json");
		const report = JSON.parse(await readFile(reportFile, "utf8"));
		delete report.ranAt;
		const rewritten = { ...report, generatedAt: dates.generatedAt };
		if (dates.ranAt !== undefined) rewritten.ranAt = dates.ranAt;
		await writeFile(reportFile, JSON.stringify(rewritten));
		return directory;
	}

	const lastRunOf = async (directory: string) => {
		const status = await suiteStatus("evals/x", directory, FORGE_VERSION);
		if (status.state !== "ok") throw new Error("expected an ok suite");
		return status.lastRun;
	};

	test("last run is the day promptfoo ran (ranAt), not the day the report was written", async () => {
		const directory = await suiteWithDates("ranat", {
			ranAt: "2026-09-25T23:59:00.000Z",
			generatedAt: "2026-09-29T08:00:00.000Z",
		});
		expect((await lastRunOf(directory))?.date).toBe("2026-09-25");
	});

	test("last run falls back to generatedAt for a report with no ranAt or a null one", async () => {
		const absent = await suiteWithDates("noranat", {
			generatedAt: "2026-09-29T08:00:00.000Z",
		});
		expect((await lastRunOf(absent))?.date).toBe("2026-09-29");
		const explicitNull = await suiteWithDates("nullranat", {
			ranAt: null,
			generatedAt: "2026-09-28T08:00:00.000Z",
		});
		expect((await lastRunOf(explicitNull))?.date).toBe("2026-09-28");
	});

	test("last run prints (unknown date) for a value that is not an ISO date, never its first ten characters", async () => {
		const garbage = await suiteWithDates("garbage", {
			ranAt: "yesterday afternoon",
			generatedAt: "2026-09-29T08:00:00.000Z",
		});
		const garbageStatus = await suiteStatus("evals/x", garbage, FORGE_VERSION);
		expect(renderStatusLine(garbageStatus)).toEndWith(
			"last run 67.9% (unknown date)",
		);
		// The JSON carries null, never the display sentinel.
		expect((await lastRunOf(garbage))?.date).toBeNull();
		const badGenerated = await suiteWithDates("badgenerated", {
			generatedAt: "not-a-date-at-all",
		});
		expect((await lastRunOf(badGenerated))?.date).toBeNull();
		const impossible = await suiteWithDates("impossible", {
			ranAt: "2026-13-45T00:00:00.000Z",
			generatedAt: "2026-09-29T08:00:00.000Z",
		});
		expect((await lastRunOf(impossible))?.date).toBeNull();
	});

	test("a hand-edited ranAt that is not a string does not refuse the report: the suite is ok and the day falls back to generatedAt", async () => {
		const directory = await suiteWithDates("numericranat", {
			generatedAt: "2026-09-29T08:00:00.000Z",
		});
		const reportFile = join(directory, ".forge", "report.json");
		const report = JSON.parse(await readFile(reportFile, "utf8"));
		await writeFile(reportFile, JSON.stringify({ ...report, ranAt: 5 }));
		expect((await lastRunOf(directory))?.date).toBe("2026-09-29");
	});

	test("the guide documents the whole status --json shape", async () => {
		const guide = await readFile(
			join(REPOSITORY, "templates/guide.md"),
			"utf8",
		);
		for (const name of [
			"suites",
			"problems",
			"featureStatus",
			"reason",
			"entry",
			"warning",
		])
			expect(guide).toContain(`\`${name}\``);
	});

	/** The suite copy with the first case of standard-multi-field-form given `status` and its `page:` key renamed `pages:`. */
	async function suiteWithRenamedKey(
		name: string,
		status: string,
	): Promise<{ directory: string; casesFile: string }> {
		const directory = await suiteCopy(name);
		const casesFile = join(
			directory,
			".forge",
			"cases",
			"standard-multi-field-form.yaml",
		);
		const text = await readFile(casesFile, "utf8");
		const rewritten = text
			.replace(/^ {4}page: /m, "    pages: ")
			.replace(/^ {2}status: approved$/m, `  status: ${status}`);
		expect(rewritten).not.toBe(text);
		await writeFile(casesFile, rewritten);
		return { directory, casesFile };
	}

	/** What the fixture suite reads as, before selectCases has its say. */
	const fixtureSummary = {
		feature: "extract-job-application-questions",
		featureStatus: "approved",
		scenarios: { approved: 14, pending: 0, rejected: 0 },
		cases: { approved: 42, pending: 0 },
		lastRun: { passRate: 0.6786, date: "2026-09-25" },
		warning: null,
	};

	test("an approved case whose input keys are not the feature's inputs is an error row with selectCases' message, never ok, and keeps the suite's counts", async () => {
		const { directory, casesFile } = await suiteWithRenamedKey(
			"renamed",
			"approved",
		);
		const status = await suiteStatus("evals/renamed", directory, FORGE_VERSION);
		const error = `case standard-multi-field-form-01's input keys do not match the feature's inputs (missing: page; extra: pages); rename them in its input: or in feature.yaml (file: ${casesFile}, id: standard-multi-field-form-01)`;
		expect(status).toEqual({
			entry: "evals/renamed",
			state: "error",
			error,
			...fixtureSummary,
		});
		expect(renderStatusLine(status)).toBe(
			`evals/renamed   extract-job-application-questions   14 scenarios approved, 0 pending · 42 cases approved, 0 pending · last run 67.9% (2026-09-25)   error: ${error}`,
		);
	});

	test("`state` stays the second key of every row, ok or refused, as status --json prints it", async () => {
		const { directory } = await suiteWithRenamedKey("keysrefused", "approved");
		const refused = await suiteStatus("evals/k", directory, FORGE_VERSION);
		const readable = await suiteStatus(
			"evals/k",
			await suiteCopy("keysok"),
			FORGE_VERSION,
		);
		for (const row of [refused, readable])
			expect(Object.keys(row).slice(0, 2)).toEqual(["entry", "state"]);
	});

	test("a refused suite's row keeps the feature pending marker and the version warning", async () => {
		const { directory } = await suiteWithRenamedKey(
			"refusedpending",
			"approved",
		);
		const forge = join(directory, ".forge");
		await writeFile(
			join(forge, "feature.yaml"),
			(await readFile(join(forge, "feature.yaml"), "utf8")).replace(
				/^status: approved$/m,
				"status: pending",
			),
		);
		// stampSuite never lowers a stamp, so the older one is written by hand.
		const suiteFile = join(forge, "suite.yaml");
		const suiteText = await readFile(suiteFile, "utf8");
		const older = suiteText.replace(
			/^forge_version: .*$/m,
			"forge_version: 0.0.1",
		);
		expect(older).not.toBe(suiteText);
		await writeFile(suiteFile, older);
		const line = renderStatusLine(
			await suiteStatus("evals/refusedpending", directory, FORGE_VERSION),
		);
		expect(line).toStartWith(
			"evals/refusedpending   extract-job-application-questions (feature pending)   14 scenarios approved",
		);
		expect(line).toContain("   error: case standard-multi-field-form-01's");
		expect(line).toMatch(
			/\) {2}⚠ this suite was written by llm-tests-forge 0\.0\.1; /,
		);
	});

	test("a rejected case with mismatched input keys is not selected, so the suite stays ok", async () => {
		const { directory } = await suiteWithRenamedKey(
			"renamedrejected",
			"rejected",
		);
		const status = await suiteStatus(
			"evals/renamedrejected",
			directory,
			FORGE_VERSION,
		);
		expect(status.state).toBe("ok");
	});

	test("with no suite.yaml yet nothing is selected, so mismatched input keys leave the suite ok (emit asks for suite.yaml first)", async () => {
		const { directory } = await suiteWithRenamedKey(
			"renamednosuite",
			"approved",
		);
		await unlink(join(directory, ".forge", "suite.yaml"));
		const status = await suiteStatus(
			"evals/renamednosuite",
			directory,
			FORGE_VERSION,
		);
		expect(status.state).toBe("ok");
	});

	/** The suite copy with suite.yaml's include naming a scenario that does not exist. */
	async function suiteWithMissingInclude(
		name: string,
	): Promise<{ directory: string; suiteFile: string }> {
		const directory = await suiteCopy(name);
		const suiteFile = join(directory, ".forge", "suite.yaml");
		const text = await readFile(suiteFile, "utf8");
		const rewritten = text.replace(/^include: \[\]$/m, "include: [gone]");
		expect(rewritten).not.toBe(text);
		await writeFile(suiteFile, rewritten);
		return { directory, suiteFile };
	}

	test("an include naming no scenario is the error row selectCases refuses it with", async () => {
		const { directory, suiteFile } =
			await suiteWithMissingInclude("badinclude");
		const status = await suiteStatus(
			"evals/badinclude",
			directory,
			FORGE_VERSION,
		);
		expect(status).toEqual({
			entry: "evals/badinclude",
			state: "error",
			error: `scenario "gone" in suite.include not found (file: ${suiteFile}, id: gone)`,
			...fixtureSummary,
		});
	});

	test("renders a report.json that does not match the schema as an error naming it", async () => {
		const directory = await suiteCopy("badreport");
		const reportFile = join(directory, ".forge", "report.json");
		await writeFile(reportFile, '{"generatedAt": 3}');
		const line = renderStatusLine(
			await suiteStatus("evals/badreport", directory, FORGE_VERSION),
		);
		expect(line).toStartWith("evals/badreport   error: ");
		expect(line).toContain(reportFile);
	});
});
