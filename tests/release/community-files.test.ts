import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const REPOSITORY = resolve(import.meta.dir, "../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
	return readFile(join(REPOSITORY, relativePath), "utf8");
}

const IssueFormSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	body: z.array(z.object({ type: z.string() })).min(1),
});

const IssueConfigSchema = z.object({
	blank_issues_enabled: z.boolean(),
	contact_links: z
		.array(z.object({ name: z.string(), url: z.string(), about: z.string() }))
		.optional(),
});

describe("CONTRIBUTING.md", () => {
	test("names the gate, the opt-in suites and the mutation scopes", async () => {
		const text = await readRepositoryFile("CONTRIBUTING.md");
		expect(text).toContain("bun run check");
		for (const suite of ["test:packages", "test:shims", "test:live"]) {
			expect(text).toContain(suite);
		}
		for (const scope of ["core", "cli", "emit", "report", "llm"]) {
			expect(text).toContain(`bun run mutation ${scope}`);
		}
	});

	test("says an agent never approves for the person", async () => {
		const text = await readRepositoryFile("CONTRIBUTING.md");
		expect(text).toContain("never marks anything approved");
	});
});

describe("SECURITY.md", () => {
	test("sends reports to GitHub private vulnerability reporting, not to an address", async () => {
		const text = await readRepositoryFile("SECURITY.md");
		expect(text).toContain("private vulnerability reporting");
		expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
	});
});

describe("CODE_OF_CONDUCT.md", () => {
	test("credits the Contributor Covenant and names its version", async () => {
		const text = await readRepositoryFile("CODE_OF_CONDUCT.md");
		expect(text).toContain("Contributor Covenant");
		expect(text).toContain("version 2.1");
		expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
	});
});

describe("CHANGELOG.md", () => {
	test("starts with its title and an Unreleased section", async () => {
		const text = await readRepositoryFile("CHANGELOG.md");
		expect(text.startsWith("# Changelog")).toBe(true);
		expect(text).toContain("## Unreleased");
	});
});

describe("GitHub templates", () => {
	test.each([
		".github/ISSUE_TEMPLATE/bug_report.yml",
		".github/ISSUE_TEMPLATE/feature_request.yml",
	])("%s is a valid issue form", async (relativePath) => {
		const form = IssueFormSchema.parse(
			parse(await readRepositoryFile(relativePath)),
		);
		expect(form.body.some((block) => block.type === "textarea")).toBe(true);
	});

	test("the issue chooser points security reports to the advisory page", async () => {
		const config = IssueConfigSchema.parse(
			parse(await readRepositoryFile(".github/ISSUE_TEMPLATE/config.yml")),
		);
		expect(config.blank_issues_enabled).toBe(false);
		expect(
			config.contact_links?.some((link) =>
				link.url.endsWith("/security/advisories/new"),
			),
		).toBe(true);
	});

	test("the pull request template asks for the gate output", async () => {
		const text = await readRepositoryFile(".github/PULL_REQUEST_TEMPLATE.md");
		expect(text).toContain("bun run check");
	});
});
