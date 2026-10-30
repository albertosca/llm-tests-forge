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
	test("prints the sorted kinds the model covered", async () => {
		const { llm } = llmReturning({
			scenarios: [
				scenario("a", "happy"),
				scenario("b", "edge"),
				scenario("c", "happy"),
			],
		});
		const output = await runScenarios(
			{ model: "fake/x", variables: { feature, kinds: "happy, edge" } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({ kinds: ["edge", "happy"] });
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
