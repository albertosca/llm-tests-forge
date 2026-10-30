import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = join(import.meta.dir, "../../scripts/dogfood/dedupe-target.ts");
const cases =
	"- id: c1\n  input: { message: a }\n  expected: { label: x }\n- id: c2\n  input: { message: b }\n  expected: { label: x }\n";

async function run(model: string, environment: Record<string, string>) {
	const child = Bun.spawn(
		[
			target,
			"prompt",
			JSON.stringify({ config: { model } }),
			JSON.stringify({ vars: { cases, __evalId: "e" } }),
		],
		{ stdout: "pipe", stderr: "pipe", env: environment },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("dedupe-target", () => {
	test("runs as the exec program promptfoo calls: exactly one JSON line on stdout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-target-"));
		const responses = join(directory, "responses.json");
		await writeFile(
			responses,
			JSON.stringify({
				dedupe: JSON.stringify({
					duplicates: [{ id: "c2", duplicate_of: "c1" }],
				}),
			}),
		);
		const result = await run(`fake/${responses}`, {
			PATH: process.env.PATH ?? "",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(result.stdout)).toEqual({
			duplicates: [{ id: "c2", duplicate_of: "c1" }],
		});
	}, 30_000);
	test("a real provider with no key fails fast, names the variable and exits 1", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-target-home-"));
		const result = await run("anthropic/claude-haiku-4-5", {
			PATH: process.env.PATH ?? "",
			HOME: directory,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ANTHROPIC_API_KEY");
	}, 30_000);
});
