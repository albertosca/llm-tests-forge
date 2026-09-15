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
		const msg = expectedMatchesOracle(
			{ fields: { type: "rejection" } },
			"label",
			await feature(),
		);
		expect(msg).toBe("oracle is label but expected.label is missing");
	});

	test("label: reports a label outside the feature's labels", async () => {
		const msg = expectedMatchesOracle(
			{ label: "maybe" },
			"label",
			await feature(),
		);
		expect(msg).toBe(`label "maybe" is not one of the feature's labels`);
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
		const msg = expectedMatchesOracle(
			{ label: "rejection" },
			"fields",
			await feature(),
		);
		expect(msg).toBe("oracle is fields but expected.fields is missing");
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
		const msg = expectedMatchesOracle(
			{ label: "rejection" },
			"rubric",
			await feature(),
		);
		expect(msg).toBe("oracle is rubric but expected.rubric is missing");
	});
});
