import { describe, expect, test } from "bun:test";
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
import { renderStatusLine, suiteStatus } from "../../src/core/status";
import { FORGE_VERSION } from "../../src/core/version";

const EXAMPLE = "examples/moonlighter-extract-questions/.forge";

/** A project directory holding a copy of the example suite at `evals/<name>`. */
async function suiteCopy(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "forge-status-"));
	const directory = join(root, "evals", name);
	await mkdir(directory, { recursive: true });
	await cp(EXAMPLE, join(directory, ".forge"), { recursive: true });
	return directory;
}

describe("suiteStatus and renderStatusLine", () => {
	test("renders the example suite as one line with its counts and last run", async () => {
		const directory = await suiteCopy("a");
		const report = JSON.parse(
			await readFile(join(directory, ".forge", "report.json"), "utf8"),
		);
		const date = report.generatedAt.slice(0, 10);
		const status = await suiteStatus("evals/a", directory, FORGE_VERSION);
		expect(renderStatusLine(status)).toBe(
			`evals/a   extract-job-application-questions   14/14 scenarios · 42 approved, 0 pending · last run 67.9% (${date})`,
		);
		expect(status).toEqual({
			entry: "evals/a",
			state: "ok",
			feature: "extract-job-application-questions",
			scenarios: { approved: 14, total: 14 },
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

	test("counts edited scenarios as approved, and pending and rejected ones as not", async () => {
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
		expect(status.scenarios).toEqual({ approved: 12, total: 14 });
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
				"forge_version: 0.1.0",
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

	test("renders a suite with no feature.yaml yet as ok with no feature and zero counts", async () => {
		const root = await mkdtemp(join(tmpdir(), "forge-status-"));
		await mkdir(join(root, ".forge"));
		const status = await suiteStatus(".", root, FORGE_VERSION);
		expect(status).toEqual({
			entry: ".",
			state: "ok",
			feature: "(no feature yet)",
			scenarios: { approved: 0, total: 0 },
			cases: { approved: 0, pending: 0 },
			lastRun: null,
			warning: null,
		});
		expect(renderStatusLine(status)).toBe(
			".   (no feature yet)   0/0 scenarios · 0 approved, 0 pending · no run yet",
		);
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
