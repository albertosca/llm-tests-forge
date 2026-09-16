import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ForgeError } from "../../src/core/errors";
import { readResults } from "../../src/report/results";

const FIXTURE = resolve("tests/fixtures/promptfoo-results-0.123.0.json");

describe("readResults", () => {
	test("reads the real promptfoo 0.123.0 file: 4 rows, metadata, judge tokens, provider label", async () => {
		const r = await readResults(FIXTURE);
		expect(r.metadata?.promptfooVersion).toBe("0.123.0");
		const rows = r.results.results;
		expect(rows.map((x) => [x.testIdx, x.metadata?.case])).toEqual([
			[0, "ack-optional-quiz-01"],
			[1, "ack-optional-quiz-01"],
			[2, "out-of-scope-newsletter-02"],
			[3, "out-of-scope-newsletter-02"],
		]);
		expect(rows[0]?.provider).toEqual({
			id: "file://forge_target.py",
			label: "target-haiku-4-5",
		});
		expect(
			rows[2]?.gradingResult?.componentResults?.[0]?.assertion?.provider,
		).toBe("google:gemini-3.5-flash");
		expect(
			rows[2]?.gradingResult?.componentResults?.[0]?.tokensUsed?.prompt,
		).toBe(265);
		expect(
			rows[2]?.gradingResult?.componentResults?.[0]?.tokensUsed
				?.completionDetails?.reasoning,
		).toBe(243);
		expect(rows[0]?.cost).toBe(0);
	});

	test("tolerates an error row with an empty gradingResult and no tokenUsage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-report-"));
		const f = join(dir, "r.json");
		await writeFile(
			f,
			JSON.stringify({
				results: {
					results: [
						{
							testIdx: 0,
							success: false,
							error: "boom",
							provider: { id: "file://x.py" },
							gradingResult: {},
							metadata: { case: "a-01" },
						},
					],
				},
			}),
		);
		const r = await readResults(f);
		expect(r.results.results[0]?.error).toBe("boom");
		expect(r.results.results[0]?.tokenUsage).toBeUndefined();
		expect(r.results.results[0]?.provider.label).toBeUndefined();
	});

	test("names the file when it is missing", async () => {
		const err = await readResults("/nowhere/results.json").catch(
			(e: Error) => e,
		);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain("/nowhere/results.json");
		expect((err as Error).message).toContain("file not found");
	});

	test("names the file and the problem when it is not JSON", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-report-"));
		const f = join(dir, "r.json");
		await writeFile(f, "{not json");
		const err = await readResults(f).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain("invalid JSON");
		expect((err as Error).message).toContain(f);
	});

	test("names the file and the path when the shape is wrong", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-report-"));
		const f = join(dir, "r.json");
		await writeFile(
			f,
			JSON.stringify({ results: { results: [{ testIdx: "zero" }] } }),
		);
		const err = await readResults(f).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain("does not match");
		expect((err as Error).message).toContain("results.results.0.testIdx");
	});

	test("reports why a directory cannot be read instead of calling it missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forge-report-"));
		const err = await readResults(dir).catch((e: Error) => e);
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as Error).message).toContain("cannot read");
		expect((err as Error).message).toContain(dir);
	});
});
