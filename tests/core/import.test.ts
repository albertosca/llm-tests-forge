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

async function twoInputFeature(): Promise<Feature> {
	return {
		...(await feature()),
		inputs: [
			{ name: "email", kind: "text" },
			{ name: "subject", kind: "text" },
		],
	};
}

/** The ForgeError `run` throws, or a failed expectation when it throws none. */
function failureOf(run: () => unknown): ForgeError {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ForgeError);
	if (!(caught instanceof ForgeError)) throw new Error("no ForgeError thrown");
	return caught;
}

describe("importCases", () => {
	test("creates pending cases without expected and the imported scenario", async () => {
		const jsonl = '{"email":"first"}\n\n{"email":"second"}\n';
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "prod.jsonl",
			existing: [],
		});
		expect(result.cases.map((created) => created.id)).toEqual([
			"imported-01",
			"imported-02",
		]);
		expect(result.cases[0]).toEqual({
			id: "imported-01",
			scenario: "imported",
			input: { email: "first" },
			status: "pending",
			generated_by: "import:prod.jsonl",
		});
		expect(result.scenario).toEqual({
			id: "imported",
			kind: "happy",
			oracle: "fields",
			description: "Real inputs imported from application logs",
			status: "approved",
		});
		expect(result.skipped).toEqual([]);
	});

	test("derives the oracle from output.kind and accepts an override", async () => {
		const loaded = await feature();
		expect(
			importCases({
				feature: { ...loaded, output: { kind: "label", labels: ["a"] } },
				jsonl: '{"email":"x"}',
				source: "s",
				existing: [],
			}).scenario.oracle,
		).toBe("label");
		expect(
			importCases({
				feature: { ...loaded, output: { kind: "text" } },
				jsonl: '{"email":"x"}',
				source: "s",
				existing: [],
			}).scenario.oracle,
		).toBe("rubric");
		expect(
			importCases({
				feature: loaded,
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
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing,
		});
		expect(result.cases.map((created) => created.id)).toEqual([
			"imported-01",
			"imported-02",
		]);
		expect(result.cases[1]?.input).toEqual({ email: "fresh" });
		expect(result.skipped).toEqual([
			{ line: 1, reason: "not valid JSON" },
			{ line: 2, reason: "keys [mail] do not match feature inputs [email]" },
			{ line: 3, reason: "exact duplicate of an existing input" },
			{ line: 4, reason: "every input value must be a string" },
		]);
	});

	test("skips a duplicate within the same file, even when neither copy pre-existed", async () => {
		const jsonl = '{"email":"twice"}\n{"email":"twice"}\n';
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(result.cases.map((created) => created.id)).toEqual(["imported-01"]);
		expect(result.cases[0]?.input).toEqual({ email: "twice" });
		expect(result.skipped).toEqual([
			{ line: 2, reason: "exact duplicate of an existing input" },
		]);
	});

	test("matches keys against all of a feature's declared inputs, not just their count", async () => {
		const jsonl =
			'{"email":"a","subject":"b"}\n{"email":"a"}\n{"email":"a","other":"b"}\n';
		const result = importCases({
			feature: await twoInputFeature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(result.cases.map((created) => created.id)).toEqual(["imported-01"]);
		expect(result.cases[0]?.input).toEqual({ email: "a", subject: "b" });
		expect(result.skipped).toEqual([
			{
				line: 2,
				reason: "keys [email] do not match feature inputs [email, subject]",
			},
			{
				line: 3,
				reason:
					"keys [email, other] do not match feature inputs [email, subject]",
			},
		]);
	});

	test("the keys a line holds are listed sorted, comma-separated, in the reason", async () => {
		const result = importCases({
			feature: await feature(),
			jsonl: '{"zeta":"1","alpha":"2"}\n{"email":"ok"}\n',
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([
			{
				line: 1,
				reason: "keys [alpha, zeta] do not match feature inputs [email]",
			},
		]);
	});

	test("every input value must be a string, not just one of them", async () => {
		const result = importCases({
			feature: await twoInputFeature(),
			jsonl: '{"email":"a","subject":7}\n{"email":"a","subject":"b"}\n',
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([
			{ line: 1, reason: "every input value must be a string" },
		]);
		expect(result.cases.map((created) => created.input)).toEqual([
			{ email: "a", subject: "b" },
		]);
	});

	test("a line of spaces, a tab or a lone carriage return is blank, not a bad line", async () => {
		const result = importCases({
			feature: await feature(),
			jsonl: '{"email":"a"}\n   \n\t\n\r\n{"email":"b"}\r\n',
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([]);
		expect(result.cases.map((created) => created.input)).toEqual([
			{ email: "a" },
			{ email: "b" },
		]);
	});

	test("throws listing each line's skip reason when every line in a non-empty file is skipped", async () => {
		const jsonl = 'not json\n{"mail":"wrong key"}\n';
		const loaded = await feature();
		const failure = failureOf(() =>
			importCases({
				feature: loaded,
				jsonl,
				source: "prod.jsonl",
				existing: [],
			}),
		);
		expect(failure.message).toBe(
			"no line imported (line 1: not valid JSON; line 2: keys [mail] do not match feature inputs [email]) (file: prod.jsonl)",
		);
		expect(failure.details.file).toBe("prod.jsonl");
	});

	test("throws with a distinct message when the file has no lines to skip", async () => {
		const loaded = await feature();
		for (const jsonl of ["", "\n  \n"]) {
			const failure = failureOf(() =>
				importCases({
					feature: loaded,
					jsonl,
					source: "prod.jsonl",
					existing: [],
				}),
			);
			expect(failure.message).toBe(
				"no line imported (file is empty) (file: prod.jsonl)",
			);
			expect(failure.details.file).toBe("prod.jsonl");
		}
	});

	test("skips JSON that parses but is not a plain object (array, number, null)", async () => {
		const jsonl = '[1,2]\n42\nnull\n{"email":"ok"}\n';
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([
			{ line: 1, reason: "not a JSON object" },
			{ line: 2, reason: "not a JSON object" },
			{ line: 3, reason: "not a JSON object" },
		]);
		expect(result.cases.map((created) => created.id)).toEqual(["imported-01"]);
		expect(result.cases[0]?.input).toEqual({ email: "ok" });
	});

	test("reports the key-mismatch reason before the value-type reason when a line fails both", async () => {
		const jsonl = '{"mail":42}\n{"email":"ok"}\n';
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([
			{ line: 1, reason: "keys [mail] do not match feature inputs [email]" },
		]);
		expect(result.cases.map((created) => created.id)).toEqual(["imported-01"]);
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
		const loaded = await feature();
		expect(() =>
			importCases({ feature: loaded, jsonl, source: "s", existing }),
		).toThrow(ForgeError);
	});

	test("keeps physical line numbers stable across a blank line", async () => {
		const jsonl = '{"email":"a"}\n\nnot json\n';
		const result = importCases({
			feature: await feature(),
			jsonl,
			source: "s",
			existing: [],
		});
		expect(result.skipped).toEqual([{ line: 3, reason: "not valid JSON" }]);
		expect(result.cases.map((created) => created.id)).toEqual(["imported-01"]);
	});
});
