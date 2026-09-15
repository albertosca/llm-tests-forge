import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature } from "../../src/core/describe";
import { ForgeError } from "../../src/core/errors";
import { createLlm, type Llm } from "../../src/llm/generate";

const FAKE = "fake/tests/fixtures/describe-response.json";
const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"fixtures",
	"describe-response.json",
);

async function llm(): Promise<Llm> {
	return createLlm({
		forgeDir: join(await mkdtemp(join(tmpdir(), "forge-")), ".forge"),
	});
}

describe("describeFeature", () => {
	test("returns a pending feature from the model's answer", async () => {
		const f = await describeFeature({
			text: "The bot classifies hiring emails",
			model: FAKE,
			llm: await llm(),
		});
		expect(f.status).toBe("pending");
		expect(f.id).toBe("classify-email");
		expect(f.output.labels).toEqual([
			"rejection",
			"acknowledgement",
			"unrelated",
		]);
		expect(f.prompt_file).toBeUndefined();
	});

	test("renders description and prompt into the template", async () => {
		const seen: string[] = [];
		// Reading and parsing the fixture (rather than a dynamic `import()` of
		// the JSON file) avoids relying on a JSON module resolution mode this
		// project's tsconfig does not enable; `JSON.parse`'s `any` result is
		// fine here since this is a test mock.
		const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
		const spy: Llm = {
			async generate(args) {
				seen.push(args.prompt);
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
	});
});
