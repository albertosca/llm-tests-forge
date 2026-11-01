import { describe, expect, test } from "bun:test";
import { runScenarios } from "../../scripts/dogfood/scenarios-run";
import { llmReturning } from "./stub-llm";

const feature = `
id: triage
purpose: label a ticket
inputs:
  - { name: message, kind: text }
output: { kind: label, labels: [refund, status] }
`;

function scenario(id: string, kind: string) {
	return { id, kind, oracle: "label", description: `${id} description` };
}

describe("runScenarios", () => {
	test("prints the sorted wanted kinds the model covered, ignoring extra ones", async () => {
		const { llm } = llmReturning({
			scenarios: [
				scenario("a", "happy"),
				scenario("b", "edge"),
				scenario("c", "language"),
			],
		});
		const output = await runScenarios(
			{ model: "fake/x", variables: { feature, kinds: "happy, edge" } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({ covered: ["edge", "happy"] });
	});
	test("without a kinds input all six are wanted and reported", async () => {
		const kinds = [
			"happy",
			"edge",
			"ambiguous",
			"out_of_scope",
			"adversarial",
			"language",
		];
		const { llm } = llmReturning({
			scenarios: kinds.map((kind) => scenario(`s-${kind}`, kind)),
		});
		const output = await runScenarios(
			{ model: "fake/x", variables: { feature } },
			llm,
		);
		expect(JSON.parse(output).covered).toEqual([...kinds].sort());
	});
	test("without a kinds input every kind is wanted, so an answer missing one is refused", async () => {
		const { llm } = llmReturning({ scenarios: [scenario("a", "happy")] });
		await expect(
			runScenarios({ model: "fake/x", variables: { feature } }, llm),
		).rejects.toThrow();
	});
	test("an empty kinds input counts as none given", async () => {
		const { llm } = llmReturning({ scenarios: [scenario("a", "happy")] });
		await expect(
			runScenarios(
				{ model: "fake/x", variables: { feature, kinds: "  " } },
				llm,
			),
		).rejects.toThrow();
	});
	test("a kind the forge does not know is refused, naming it", async () => {
		const { llm } = llmReturning({ scenarios: [] });
		await expect(
			runScenarios(
				{ model: "fake/x", variables: { feature, kinds: "happy,odd" } },
				llm,
			),
		).rejects.toThrow('names "odd"');
	});
	test("a missing feature input is refused", async () => {
		const { llm } = llmReturning({ scenarios: [] });
		await expect(
			runScenarios({ model: "fake/x", variables: {} }, llm),
		).rejects.toThrow("needs the `feature` input");
	});
});
