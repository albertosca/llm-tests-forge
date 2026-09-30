import { describe, expect, test } from "bun:test";
import { nextCaseId, slugify } from "../../src/core/ids";
import type { Case } from "../../src/core/schemas";

describe("slugify", () => {
	test("kebab-cases and trims", () => {
		expect(slugify("Ack with Optional Quiz!")).toBe("ack-with-optional-quiz");
		expect(slugify("a".repeat(60))).toHaveLength(40);
	});

	test("folds accents to their plain letter instead of dropping them", () => {
		expect(slugify("Retorno do processo seletivo — confirmação")).toBe(
			"retorno-do-processo-seletivo-confirmacao",
		);
		expect(slugify("ação")).toBe("acao");
		expect(slugify("  --Já--  ")).toBe("ja");
	});

	test("a run of spaces and symbols between two words becomes one dash", () => {
		expect(slugify("fast --- & cheap")).toBe("fast-cheap");
	});

	test("a slug cut at 40 characters never ends in a dash", () => {
		const fortiethCharacterIsDash = `${"a".repeat(39)} b`;
		expect(slugify(fortiethCharacterIsDash)).toBe("a".repeat(39));
	});
});

describe("nextCaseId", () => {
	const caseWithId = (id: string): Case => ({
		id,
		scenario: "s",
		input: {},
		status: "pending",
		generated_by: "t",
	});
	test("starts at 01 and continues after the highest suffix", () => {
		expect(nextCaseId("s", [])).toBe("s-01");
		expect(
			nextCaseId("s", [
				caseWithId("s-01"),
				caseWithId("s-07"),
				caseWithId("other-99"),
			]),
		).toBe("s-08");
	});

	test("the highest suffix wins wherever it sits in the list", () => {
		expect(nextCaseId("s", [caseWithId("s-07"), caseWithId("s-02")])).toBe(
			"s-08",
		);
	});

	test("a case of another scenario never advances the numbering, even one whose id is as long", () => {
		expect(
			nextCaseId("tone", [caseWithId("tone-01"), caseWithId("form-09")]),
		).toBe("tone-02");
	});

	test("ignores a non-numeric suffix instead of producing s-NaN", () => {
		expect(nextCaseId("s", [caseWithId("s-01"), caseWithId("s-abc")])).toBe(
			"s-02",
		);
	});

	test("rolls past two digits without truncating", () => {
		expect(nextCaseId("s", [caseWithId("s-99")])).toBe("s-100");
	});
});
