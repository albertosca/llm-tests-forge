import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/core/errors";
import { forgePaths } from "../../src/core/files";
import type { Case, Scenario, Suite } from "../../src/core/schemas";
import { selectCases } from "../../src/core/select";

const paths = forgePaths("/p/.forge");
const scenario = (id: string, status: Scenario["status"]): Scenario => ({
	id,
	kind: "happy",
	oracle: "label",
	description: id,
	status,
});
const kase = (
	id: string,
	scenario: string,
	status: Case["status"],
	expected = true,
): Case => ({
	id,
	scenario,
	input: { email: id },
	status,
	generated_by: "t",
	...(expected ? { expected: { label: "rejection" } } : {}),
});
const suite = (include: string[] = []): Suite => ({
	target: {
		kind: "promptfoo-python",
		entry: "forge_target.py",
		models: ["anthropic/claude-haiku-4-5"],
	},
	judges: ["google/gemini-3.5-flash"],
	repeat: 1,
	include,
});

describe("selectCases", () => {
	test("with an empty include, takes every approved or edited scenario and their approved or edited cases, in file order", () => {
		const s = selectCases({
			suite: suite(),
			scenarios: [
				scenario("a", "approved"),
				scenario("b", "edited"),
				scenario("c", "rejected"),
			],
			casesByScenario: new Map([
				[
					"a",
					[
						kase("a-01", "a", "approved"),
						kase("a-02", "a", "rejected"),
						kase("a-03", "a", "edited"),
					],
				],
				["b", [kase("b-01", "b", "approved")]],
				["c", [kase("c-01", "c", "approved")]],
			]),
			paths,
		});
		expect(s.scenarios.map((x) => x.id)).toEqual(["a", "b"]);
		expect(s.cases.map((c) => c.id)).toEqual(["a-01", "a-03", "b-01"]);
		expect(s.blockers).toEqual([]);
	});
	test("a pending case is a blocker naming the case and its file, and is not selected", () => {
		const s = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([
				["a", [kase("a-01", "a", "pending"), kase("a-02", "a", "approved")]],
			]),
			paths,
		});
		expect(s.cases.map((c) => c.id)).toEqual(["a-02"]);
		expect(s.blockers).toEqual([
			"case a-01 is pending (/p/.forge/cases/a.yaml)",
		]);
	});
	test("an approved case with no expected is a blocker (hand-edited file)", () => {
		const s = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved", false)]]]),
			paths,
		});
		expect(s.cases).toEqual([]);
		expect(s.blockers).toEqual([
			"case a-01 has no expected (/p/.forge/cases/a.yaml)",
		]);
	});
	test("include narrows to the named scenarios, in include order", () => {
		const s = selectCases({
			suite: suite(["b", "a"]),
			scenarios: [
				scenario("a", "approved"),
				scenario("b", "approved"),
				scenario("z", "approved"),
			],
			casesByScenario: new Map([
				["a", [kase("a-01", "a", "approved")]],
				["b", [kase("b-01", "b", "approved")]],
				["z", [kase("z-01", "z", "approved")]],
			]),
			paths,
		});
		expect(s.scenarios.map((x) => x.id)).toEqual(["b", "a"]);
		expect(s.cases.map((c) => c.id)).toEqual(["b-01", "a-01"]);
	});
	test("an included scenario that is pending is a blocker naming scenarios.yaml, and contributes no cases", () => {
		const s = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "pending")],
			casesByScenario: new Map([["a", [kase("a-01", "a", "approved")]]]),
			paths,
		});
		expect(s.scenarios).toEqual([]);
		expect(s.cases).toEqual([]);
		expect(s.blockers).toEqual([
			"scenario a is pending (/p/.forge/scenarios.yaml)",
		]);
	});
	test("an included scenario that is rejected is a blocker too", () => {
		const s = selectCases({
			suite: suite(["a"]),
			scenarios: [scenario("a", "rejected")],
			casesByScenario: new Map(),
			paths,
		});
		expect(s.blockers).toEqual([
			"scenario a is rejected (/p/.forge/scenarios.yaml)",
		]);
	});
	test("an include id that matches no scenario is a ForgeError naming suite.yaml and the id", () => {
		expect(() =>
			selectCases({
				suite: suite(["ghost"]),
				scenarios: [scenario("a", "approved")],
				casesByScenario: new Map(),
				paths,
			}),
		).toThrow(ForgeError);
		try {
			selectCases({
				suite: suite(["ghost"]),
				scenarios: [],
				casesByScenario: new Map(),
				paths,
			});
		} catch (e) {
			expect((e as ForgeError).message).toContain(
				'scenario "ghost" in suite.include not found',
			);
			expect((e as ForgeError).details).toEqual({
				file: "/p/.forge/suite.yaml",
				id: "ghost",
			});
		}
	});
	test("an approved scenario with no cases file is selected with zero cases (report needs it for coverage)", () => {
		const s = selectCases({
			suite: suite(),
			scenarios: [scenario("a", "approved")],
			casesByScenario: new Map(),
			paths,
		});
		expect(s.scenarios.map((x) => x.id)).toEqual(["a"]);
		expect(s.cases).toEqual([]);
		expect(s.blockers).toEqual([]);
	});
});
