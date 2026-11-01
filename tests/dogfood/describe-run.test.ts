import { describe, expect, test } from "bun:test";
import { runDescribe } from "../../scripts/dogfood/describe-run";
import { llmReturning } from "./stub-llm";

const labelFeature = {
	id: "triage",
	purpose: "label a ticket",
	inputs: [{ name: "message", kind: "text" }],
	output: { kind: "label", labels: ["status", "refund"] },
	invariants: ["answers with one label"],
};

describe("runDescribe", () => {
	test("prints the structure of a label feature, labels sorted", async () => {
		const { llm } = llmReturning(labelFeature);
		const output = await runDescribe(
			{ model: "fake/x", variables: { description: "label tickets" } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({
			input_count: 1,
			output_kind: "label",
			labels: ["refund", "status"],
			has_invariants: true,
			status: "pending",
		});
	});
	test("a text feature has no labels key and no invariants", async () => {
		const { llm } = llmReturning({
			...labelFeature,
			output: { kind: "text" },
			invariants: [],
		});
		const output = await runDescribe(
			{ model: "fake/x", variables: { description: "summarise" } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({
			input_count: 1,
			output_kind: "text",
			has_invariants: false,
			status: "pending",
		});
	});
	test("the optional prompt text reaches the model", async () => {
		const { llm, calls } = llmReturning(labelFeature);
		await runDescribe(
			{
				model: "fake/x",
				variables: { description: "d", prompt: "PROMPT-BODY" },
			},
			llm,
		);
		expect(JSON.stringify(calls)).toContain("PROMPT-BODY");
	});
	test("a missing description is refused", async () => {
		const { llm } = llmReturning(labelFeature);
		await expect(
			runDescribe({ model: "fake/x", variables: {} }, llm),
		).rejects.toThrow("needs the `description` input");
	});
});
