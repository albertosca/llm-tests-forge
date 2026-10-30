import { describe, expect, test } from "bun:test";
import { runCases } from "../../scripts/dogfood/cases-run";
import { llmReturning } from "./stub-llm";

const feature = `
id: triage
purpose: label a ticket
inputs:
  - { name: message, kind: text }
output: { kind: label, labels: [refund, status] }
`;
const scenario =
	"id: s\nkind: happy\noracle: label\ndescription: a plain refund\n";

function answer(...labels: string[]) {
	return {
		cases: labels.map((label) => ({
			input: { message: `about ${label}` },
			expected: { label },
		})),
	};
}

describe("runCases", () => {
	test("prints the input names and the expected shapes of the cases", async () => {
		const { llm } = llmReturning(answer("refund", "status"));
		const output = await runCases(
			{ model: "fake/x", variables: { feature, scenario, n: "2" } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({
			within_n: true,
			input_names: ["message"],
			expected_kinds: ["label"],
		});
	});
	test("a case whose label is outside the feature's labels is refused", async () => {
		const { llm } = llmReturning(answer("billing"));
		await expect(
			runCases(
				{ model: "fake/x", variables: { feature, scenario, n: "1" } },
				llm,
			),
		).rejects.toThrow();
	});
	test("n must be a positive integer", async () => {
		const { llm } = llmReturning(answer("refund"));
		for (const count of ["0", "-1", "1.5", "many"])
			await expect(
				runCases(
					{ model: "fake/x", variables: { feature, scenario, n: count } },
					llm,
				),
			).rejects.toThrow("positive integer");
	});
	test("a missing input is refused, naming it", async () => {
		const { llm } = llmReturning(answer("refund"));
		for (const missing of ["feature", "scenario", "n"]) {
			const variables: Record<string, string> = { feature, scenario, n: "1" };
			delete variables[missing];
			await expect(
				runCases({ model: "fake/x", variables }, llm),
			).rejects.toThrow(`needs the \`${missing}\` input`);
		}
	});
});
