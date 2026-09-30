import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expectedMatchesOracle } from "../../src/core/oracle";
import type { Feature } from "../../src/core/schemas";

async function feature(): Promise<Feature> {
	return parse(
		await readFile(join(import.meta.dir, "../fixtures/feature.yaml"), "utf8"),
	);
}

describe("expectedMatchesOracle", () => {
	test("label: null when the label is one of the feature's labels", async () => {
		expect(
			expectedMatchesOracle({ label: "rejection" }, "label", await feature()),
		).toBeNull();
	});

	test("label: reports a missing expected.label", async () => {
		const message = expectedMatchesOracle(
			{ fields: { type: "rejection" } },
			"label",
			await feature(),
		);
		expect(message).toBe("oracle is label but expected.label is missing");
	});

	test("label: reports a label outside the feature's labels", async () => {
		const message = expectedMatchesOracle(
			{ label: "maybe" },
			"label",
			await feature(),
		);
		expect(message).toBe(`label "maybe" is not one of the feature's labels`);
	});

	test("label: a feature that declares no labels accepts no label at all", async () => {
		const withoutLabels: Feature = {
			...(await feature()),
			output: { kind: "json", fields: ["type"] },
		};
		expect(
			expectedMatchesOracle({ label: "rejection" }, "label", withoutLabels),
		).toBe(`label "rejection" is not one of the feature's labels`);
	});

	test("fields: null when expected.fields is present", async () => {
		expect(
			expectedMatchesOracle(
				{ fields: { type: "rejection" } },
				"fields",
				await feature(),
			),
		).toBeNull();
	});

	test("fields: reports a missing expected.fields", async () => {
		const message = expectedMatchesOracle(
			{ label: "rejection" },
			"fields",
			await feature(),
		);
		expect(message).toBe("oracle is fields but expected.fields is missing");
	});

	test("fields: reports an empty expected.fields, which would check nothing", async () => {
		expect(
			expectedMatchesOracle({ fields: {} }, "fields", await feature()),
		).toBe(
			"oracle is fields but expected.fields is empty, so nothing would be checked",
		);
	});

	test("rubric: null when expected.rubric is present", async () => {
		expect(
			expectedMatchesOracle(
				{ rubric: "checks something" },
				"rubric",
				await feature(),
			),
		).toBeNull();
	});

	test("rubric: reports a missing expected.rubric", async () => {
		const message = expectedMatchesOracle(
			{ label: "rejection" },
			"rubric",
			await feature(),
		);
		expect(message).toBe("oracle is rubric but expected.rubric is missing");
	});
});
