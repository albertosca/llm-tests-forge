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
});

describe("nextCaseId", () => {
	const c = (id: string): Case => ({
		id,
		scenario: "s",
		input: {},
		status: "pending",
		generated_by: "t",
	});
	test("starts at 01 and continues after the highest suffix", () => {
		expect(nextCaseId("s", [])).toBe("s-01");
		expect(nextCaseId("s", [c("s-01"), c("s-07"), c("other-99")])).toBe("s-08");
	});

	test("ignores a non-numeric suffix instead of producing s-NaN", () => {
		expect(nextCaseId("s", [c("s-01"), c("s-abc")])).toBe("s-02");
	});

	test("rolls past two digits without truncating", () => {
		expect(nextCaseId("s", [c("s-99")])).toBe("s-100");
	});
});
