import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ForgeError } from "../../src/core/errors";
import { importCases } from "../../src/core/import";
import type { Case, Feature } from "../../src/core/schemas";

async function feature(): Promise<Feature> {
	return parse(
		await readFile(join(import.meta.dir, "../fixtures/feature.yaml"), "utf8"),
	);
}

describe("importCases", () => {
	test("creates pending cases without expected and the imported scenario", async () => {
		const jsonl = '{"email":"first"}\n\n{"email":"second"}\n';
		const r = importCases({
			feature: await feature(),
			jsonl,
			source: "prod.jsonl",
			existing: [],
		});
		expect(r.cases.map((c) => c.id)).toEqual(["imported-01", "imported-02"]);
		expect(r.cases[0]).toEqual({
			id: "imported-01",
			scenario: "imported",
			input: { email: "first" },
			status: "pending",
			generated_by: "import:prod.jsonl",
		});
		expect(r.scenario).toEqual({
			id: "imported",
			kind: "happy",
			oracle: "fields",
			description: "Real inputs imported from application logs",
			status: "approved",
		});
		expect(r.skipped).toEqual([]);
	});

	test("derives the oracle from output.kind and accepts an override", async () => {
		const f = await feature();
		expect(
			importCases({
				feature: { ...f, output: { kind: "label", labels: ["a"] } },
				jsonl: '{"email":"x"}',
				source: "s",
				existing: [],
			}).scenario.oracle,
		).toBe("label");
		expect(
			importCases({
				feature: { ...f, output: { kind: "text" } },
				jsonl: '{"email":"x"}',
				source: "s",
				existing: [],
			}).scenario.oracle,
		).toBe("rubric");
		expect(
			importCases({
				feature: f,
				jsonl: '{"email":"x"}',
				source: "s",
				existing: [],
				oracle: "rubric",
			}).scenario.oracle,
		).toBe("rubric");
	});

	test("skips bad lines with line numbers and reasons, and exact duplicates", async () => {
		const existing: Case[] = [
			{
				id: "imported-01",
				scenario: "imported",
				input: { email: "dup" },
				status: "approved",
				generated_by: "import:old",
			},
		];
		const jsonl =
			'not json\n{"mail":"wrong key"}\n{"email":"dup"}\n{"email":42}\n{"email":"fresh"}\n';
		const r = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing,
		});
		expect(r.cases.map((c) => c.id)).toEqual(["imported-01", "imported-02"]);
		expect(r.cases[1]?.input).toEqual({ email: "fresh" });
		expect(r.skipped.map((s) => s.line)).toEqual([1, 2, 3, 4]);
		expect(r.skipped[0]?.reason).toContain("JSON");
	});

	test("throws listing each line's skip reason when every line in a non-empty file is skipped", async () => {
		const jsonl = 'not json\n{"mail":"wrong key"}\n';
		const f = await feature();
		const err = (() => {
			try {
				importCases({ feature: f, jsonl, source: "prod.jsonl", existing: [] });
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("line 1: not valid JSON");
		expect((err as ForgeError).message).toContain(
			"line 2: keys [mail] do not match feature inputs [email]",
		);
		expect((err as ForgeError).details.file).toBe("prod.jsonl");
	});

	test("throws with a distinct message when the file has no lines to skip", async () => {
		const f = await feature();
		const err = (() => {
			try {
				importCases({
					feature: f,
					jsonl: "",
					source: "prod.jsonl",
					existing: [],
				});
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(ForgeError);
		expect((err as ForgeError).message).toContain("file is empty");
		expect((err as ForgeError).message).not.toContain("line 1");
		expect((err as ForgeError).details.file).toBe("prod.jsonl");
	});

	test("skips JSON that parses but is not a plain object (array, number, null)", async () => {
		const jsonl = '[1,2]\n42\nnull\n{"email":"ok"}\n';
		const r = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(r.skipped).toEqual([
			{ line: 1, reason: "not a JSON object" },
			{ line: 2, reason: "not a JSON object" },
			{ line: 3, reason: "not a JSON object" },
		]);
		expect(r.cases.map((c) => c.id)).toEqual(["imported-01"]);
		expect(r.cases[0]?.input).toEqual({ email: "ok" });
	});

	test("reports the key-mismatch reason before the value-type reason when a line fails both", async () => {
		const jsonl = '{"mail":42}\n{"email":"ok"}\n';
		const r = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(r.skipped).toEqual([
			{ line: 1, reason: "keys [mail] do not match feature inputs [email]" },
		]);
		expect(r.cases.map((c) => c.id)).toEqual(["imported-01"]);
	});

	test("throws when every line duplicates an existing input, even though existing already had cases", async () => {
		const existing: Case[] = [
			{
				id: "imported-01",
				scenario: "imported",
				input: { email: "dup" },
				status: "approved",
				generated_by: "import:old",
			},
		];
		const jsonl = '{"email":"dup"}\n';
		const f = await feature();
		expect(() =>
			importCases({ feature: f, jsonl, source: "s", existing }),
		).toThrow(ForgeError);
	});

	test("keeps physical line numbers stable across a blank line", async () => {
		const jsonl = '{"email":"a"}\n\nnot json\n';
		const r = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(r.skipped).toEqual([{ line: 3, reason: "not valid JSON" }]);
		expect(r.cases.map((c) => c.id)).toEqual(["imported-01"]);
	});
});
