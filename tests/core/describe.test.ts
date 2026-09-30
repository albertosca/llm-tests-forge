import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature } from "../../src/core/describe";
import { ForgeError } from "../../src/core/errors";
import type { Feature } from "../../src/core/schemas";
import { createLlm, type Llm } from "../../src/llm/generate";
import { fixturePath } from "../helpers/repository";

const FAKE = `fake/${fixturePath("describe-response.json")}`;
const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"fixtures",
	"describe-response.json",
);

async function llm(): Promise<Llm> {
	return createLlm({
		forgeDirectory: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
}

describe("describeFeature", () => {
	test("returns a pending feature from the model's answer", async () => {
		const feature = await describeFeature({
			text: "The bot classifies hiring emails",
			model: FAKE,
			llm: await llm(),
		});
		expect(feature.status).toBe("pending");
		expect(feature.id).toBe("classify-email");
		expect(feature.output.labels).toEqual([
			"rejection",
			"acknowledgement",
			"unrelated",
		]);
		expect(feature.prompt_file).toBeUndefined();
	});

	test("renders description and prompt into the template", async () => {
		const seen: string[] = [];
		// Reading and parsing the fixture (rather than a dynamic `import()` of
		// the JSON file) avoids relying on a JSON module resolution mode this
		// project's tsconfig does not enable; `JSON.parse`'s `any` result is
		// fine here since this is a test mock.
		const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
		const spy: Llm = {
			async generate(request) {
				seen.push(request.prompt);
				return {
					object: JSON.parse(fixture.describe),
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			},
		};
		await describeFeature({
			text: "DESC-TEXT",
			promptText: "PROMPT-TEXT",
			model: "anthropic/x",
			llm: spy,
		});
		expect(seen[0]).toContain("DESC-TEXT");
		expect(seen[0]).toContain("PROMPT-TEXT");
	});

	test("rejects blank text", async () => {
		await expect(
			describeFeature({ text: "   ", model: FAKE, llm: await llm() }),
		).rejects.toThrow(ForgeError);
		await expect(
			describeFeature({ text: " \n\t", model: FAKE, llm: await llm() }),
		).rejects.toThrow("describe needs a non-empty description");
	});
});

describe("describeFeature, as the model is asked and answered", () => {
	/**
	 * Answers with `answer`, read through the schema the caller asked with
	 * (as the real model call does), and records every prompt it was sent.
	 */
	function recordingLlm(answer: unknown): { llm: Llm; prompts: string[] } {
		const prompts: string[] = [];
		return {
			prompts,
			llm: {
				async generate(request) {
					prompts.push(request.prompt);
					return {
						object: request.schema.parse(answer),
						usage: { inputTokens: 0, outputTokens: 0 },
					};
				},
			},
		};
	}
	const ANSWER: Omit<Feature, "status"> = {
		id: "classify-email",
		purpose: "Classifies hiring emails.",
		inputs: [{ name: "email", kind: "text" }],
		output: { kind: "label", labels: ["rejection", "unrelated"] },
		invariants: [],
	};

	test("the description is quoted trimmed, and with no prompt given the prompt section is empty", async () => {
		const { llm: recording, prompts } = recordingLlm(ANSWER);
		await describeFeature({
			text: "  \n The bot classifies hiring emails \n\n",
			model: "anthropic/x",
			llm: recording,
		});
		expect(prompts[0]).toContain(
			"<description>\nThe bot classifies hiring emails\n</description>",
		);
		expect(prompts[0]).toContain("<prompt>\n\n</prompt>");
	});

	test("the model never chooses the prompt file nor the status: a feature it describes is pending, with no prompt file", async () => {
		const { llm: recording } = recordingLlm({
			...ANSWER,
			prompt_file: "prompts/chosen-by-the-model.md",
			status: "approved",
		});
		const feature = await describeFeature({
			text: "The bot classifies hiring emails",
			model: "anthropic/x",
			llm: recording,
		});
		expect(feature).toStrictEqual({ ...ANSWER, status: "pending" });
	});
});
