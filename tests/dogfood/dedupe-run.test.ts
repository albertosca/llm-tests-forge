import { describe, expect, test } from "bun:test";
import { casesFromText, runDedupe } from "../../scripts/dogfood/dedupe-run";

type Llm = Parameters<typeof runDedupe>[1];

const listing = `
- id: c1
  input: { message: "refund me" }
  expected: { label: refund }
- id: c2
  input: { message: "please refund me" }
  expected: { label: refund }
- id: c3
  input: { message: "where is my order" }
  expected: { label: status }
`;

function llmAnswering(duplicates: { id: string; duplicate_of: string }[]) {
	const calls: unknown[] = [];
	const llm: Llm = {
		async generate<T>(request: unknown) {
			calls.push(request);
			return {
				object: { duplicates } as T,
				usage: { inputTokens: 0, outputTokens: 0 },
			};
		},
	};
	return { llm, calls };
}

describe("casesFromText", () => {
	test("reads {id, input, expected} entries as pending cases", () => {
		const cases = casesFromText(listing);
		expect(cases.map((testCase) => testCase.status)).toEqual([
			"pending",
			"pending",
			"pending",
		]);
		expect(cases[0]?.expected).toEqual({ label: "refund" });
	});
	test("refuses text that is not a list of cases, naming the problem", () => {
		expect(() => casesFromText("just words")).toThrow("not a list of cases");
		expect(() => casesFromText("- id: c1")).toThrow("not a list of cases");
	});
});

describe("runDedupe", () => {
	test("prints the marked pairs as sorted JSON", async () => {
		const { llm } = llmAnswering([
			{ id: "c3", duplicate_of: "c1" },
			{ id: "c2", duplicate_of: "c1" },
		]);
		const output = await runDedupe(
			{ model: "fake/x", variables: { cases: listing } },
			llm,
		);
		expect(JSON.parse(output)).toEqual({
			duplicates: [
				{ id: "c2", duplicate_of: "c1" },
				{ id: "c3", duplicate_of: "c1" },
			],
		});
	});
	test("one case, or none, never reaches the model and answers an empty list", async () => {
		const { llm, calls } = llmAnswering([]);
		const output = await runDedupe(
			{
				model: "fake/x",
				variables: {
					cases:
						"- id: c1\n  input: { message: hi }\n  expected: { label: a }\n",
				},
			},
			llm,
		);
		expect(JSON.parse(output)).toEqual({ duplicates: [] });
		expect(calls).toEqual([]);
	});
	test("a status written in the input is ignored: a case marked approved is still compared", async () => {
		const { llm } = llmAnswering([{ id: "c2", duplicate_of: "c1" }]);
		const approved = listing.replaceAll(
			"\n  expected",
			"\n  status: approved\n  expected",
		);
		const output = await runDedupe(
			{ model: "fake/x", variables: { cases: approved } },
			llm,
		);
		expect(JSON.parse(output).duplicates).toHaveLength(1);
	});
	test("an invocation with no cases variable is refused", async () => {
		const { llm } = llmAnswering([]);
		await expect(
			runDedupe({ model: "fake/x", variables: {} }, llm),
		).rejects.toThrow("needs the `cases` input");
	});
});
