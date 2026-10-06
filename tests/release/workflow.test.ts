import { describe, expect, test } from "bun:test";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { SCOPE_NAMES } from "../../scripts/mutation/scopes.mjs";
import { writeChecksums } from "../../scripts/release/checksums";
import {
	CHECKSUMS_FILE_NAME,
	RELEASE_TARGETS,
} from "../../scripts/release/targets";
import { FORGE_VERSION } from "../../src/core/version";
import { ISOLATED_HOME } from "../helpers/isolated-home";

const REPOSITORY = resolve(import.meta.dir, "../..");
const RELEASE_WORKFLOW = join(REPOSITORY, ".github/workflows/release.yml");
const LINT_WORKFLOW = join(REPOSITORY, ".github/workflows/lint.yml");
const CI_WORKFLOW = join(REPOSITORY, ".github/workflows/ci.yml");
const MUTATION_WORKFLOW = join(REPOSITORY, ".github/workflows/mutation.yml");

const StepSchema = z.object({
	id: z.string().optional(),
	name: z.string().optional(),
	uses: z.string().optional(),
	run: z.string().optional(),
	if: z.string().optional(),
	with: z.record(z.string(), z.unknown()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	"continue-on-error": z.union([z.boolean(), z.string()]).optional(),
});
type Step = z.infer<typeof StepSchema>;

const JobSchema = z.object({
	"runs-on": z.string(),
	needs: z.union([z.string(), z.array(z.string())]).optional(),
	if: z.string().optional(),
	permissions: z.record(z.string(), z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	strategy: z
		.object({
			"fail-fast": z.boolean().optional(),
			matrix: z.object({
				include: z.array(
					z.record(z.string(), z.union([z.string(), z.number()])),
				),
			}),
		})
		.optional(),
	"continue-on-error": z.union([z.boolean(), z.string()]).optional(),
	"timeout-minutes": z.union([z.number(), z.string()]).optional(),
	steps: z.array(StepSchema),
});
type Job = z.infer<typeof JobSchema>;

const WorkflowSchema = z.object({
	name: z.string(),
	on: z.unknown(),
	permissions: z.record(z.string(), z.string()).optional(),
	jobs: z.record(z.string(), JobSchema),
});

async function readWorkflow(path: string) {
	return WorkflowSchema.parse(parse(await readFile(path, "utf8")));
}

const workflowText = await readFile(RELEASE_WORKFLOW, "utf8");
const workflow = WorkflowSchema.parse(parse(workflowText));

function jobNamed(name: string): Job {
	const job = workflow.jobs[name];
	if (job === undefined) throw new Error(`release.yml has no job ${name}`);
	return job;
}

function stepNamed(job: Job, name: string): Step {
	const step = job.steps.find((candidate) => candidate.name === name);
	if (step === undefined) throw new Error(`no step named ${name}`);
	return step;
}

function needsOf(job: Job): string[] {
	if (job.needs === undefined) return [];
	return typeof job.needs === "string" ? [job.needs] : job.needs;
}

/** Runs a step's script the way a runner's `shell: bash` does (`bash --noprofile --norc -eo pipefail`). */
function runStep(
	script: string,
	workingDirectory: string,
	variables: Record<string, string>,
): { exitCode: number; output: string } {
	const child = Bun.spawnSync(
		["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
		{
			cwd: workingDirectory,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				...variables,
			},
		},
	);
	return {
		exitCode: child.exitCode,
		output: `${child.stdout.toString()}${child.stderr.toString()}`,
	};
}

function scriptOf(step: Step): string {
	if (step.run === undefined)
		throw new Error(`step ${step.name ?? step.uses} has no script`);
	return step.run;
}

/** The registry each publish job serves, the secret it maps, and the name its notices give it. */
/**
 * The registry each publish job serves, the secret it maps, the job-level
 * boolean that says whether that secret is set, the one step that receives
 * the secret itself, and the name its notices give the registry.
 */
const PUBLISH_JOBS = [
	{
		job: "publish-npm",
		token: "NPM_TOKEN",
		flag: "NPM_TOKEN_SET",
		publishStep: "Publish the platform packages, then the main package",
		registry: "npm",
	},
	{
		job: "publish-pypi",
		token: "PYPI_TOKEN",
		flag: "PYPI_TOKEN_SET",
		publishStep: "Publish the wheels",
		registry: "PyPI",
	},
	{
		job: "publish-hex",
		token: "HEX_API_KEY",
		flag: "HEX_API_KEY_SET",
		publishStep: "Publish the Hex package",
		registry: "Hex",
	},
	{
		job: "publish-gem",
		token: "GEM_HOST_API_KEY",
		flag: "GEM_HOST_API_KEY_SET",
		publishStep: "Push the gems",
		registry: "RubyGems",
	},
	{
		job: "publish-homebrew",
		token: "HOMEBREW_TAP_TOKEN",
		flag: "HOMEBREW_TAP_TOKEN_SET",
		publishStep: "Check out the tap",
		registry: "Homebrew",
	},
] as const;

const ALLOWED_SECRETS = new Set<string>([
	...PUBLISH_JOBS.map((publish) => publish.token),
	"GITHUB_TOKEN",
]);

/** The only guard a publish step may carry: its own token is set and the tag is not a prerelease. */
function publishGuard(flag: string): string {
	return `env.${flag} == 'true' && !contains(github.ref_name, '-')`;
}

const SMOKE_RUNNERS: Record<string, string> = {
	"macos-15": "llm-tests-forge-darwin-arm64",
	"macos-15-intel": "llm-tests-forge-darwin-x64",
	"ubuntu-24.04": "llm-tests-forge-linux-x64",
	"ubuntu-24.04-arm": "llm-tests-forge-linux-arm64",
	"windows-2025": "llm-tests-forge-windows-x64.exe",
};

describe("the release workflow's shape", () => {
	test("it runs on v* tags and nothing else", () => {
		expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
	});

	test("every job reads the repository only, except release, which writes it and alone may sign attestations", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
		for (const [name, job] of Object.entries(workflow.jobs))
			expect({ name, permissions: job.permissions }).toEqual({
				name,
				permissions:
					name === "release"
						? {
								contents: "write",
								"id-token": "write",
								attestations: "write",
							}
						: { contents: "read" },
			});
	});

	test("the jobs run in order: check, build, smoke and assemble and packages, release, then the publishers", () => {
		expect(needsOf(jobNamed("check"))).toEqual([]);
		expect(needsOf(jobNamed("build"))).toEqual(["check"]);
		expect(needsOf(jobNamed("smoke"))).toEqual(["build"]);
		expect(needsOf(jobNamed("assemble"))).toEqual(["build"]);
		expect(needsOf(jobNamed("release")).sort()).toEqual([
			"assemble",
			"packages",
			"smoke",
		]);
		expect(needsOf(jobNamed("packages"))).toEqual(["check"]);
		expect(Object.keys(workflow.jobs).sort()).toEqual(
			[
				"check",
				"packages",
				"build",
				"smoke",
				"assemble",
				"release",
				...PUBLISH_JOBS.map((publish) => publish.job),
			].sort(),
		);
	});

	test("the check job runs the gate, the manifest version check, and the Ruby lint", () => {
		const scripts = jobNamed("check").steps.map((step) => step.run ?? "");
		expect(scripts).toContain("bun run check");
		expect(scripts).toContain("bun scripts/release/version.ts check");
		expect(scripts).toContain("bun run lint:ruby");
	});

	test("the build job cross-compiles the five binaries on one ubuntu runner and writes SHA256SUMS", () => {
		const build = jobNamed("build");
		expect(build["runs-on"]).toBe("ubuntu-24.04");
		const scripts = build.steps.map((step) => step.run ?? "");
		expect(scripts).toContain("bun run release:build");
		expect(scripts).toContain("bun scripts/release/checksums.ts dist");
	});

	test("the smoke matrix names the five native runners, each with its own asset", () => {
		const smoke = jobNamed("smoke");
		expect(smoke["runs-on"]).toBe(`\${{ matrix.runner }}`);
		const include = smoke.strategy?.matrix.include ?? [];
		expect(
			Object.fromEntries(include.map((entry) => [entry.runner, entry.asset])),
		).toEqual(SMOKE_RUNNERS);
		expect(include).toHaveLength(5);
		expect(Object.values(SMOKE_RUNNERS).sort()).toEqual(
			RELEASE_TARGETS.map((target) => target.assetName).sort(),
		);
		expect(smoke.strategy?.["fail-fast"]).toBe(false);
	});

	test("every action in every workflow is pinned by its current major version (setup-uv, which publishes no major tags, by its release), and bun is the version CI uses", async () => {
		const allowed = new Set([
			"actions/checkout@v7",
			"oven-sh/setup-bun@v2",
			"actions/upload-artifact@v7",
			"actions/download-artifact@v8",
			"ruby/setup-ruby@v1",
			"astral-sh/setup-uv@v10.2.0",
			"actions/setup-node@v7",
			"erlef/setup-beam@v1",
			"actions/attest@v4",
		]);
		for (const path of [
			RELEASE_WORKFLOW,
			CI_WORKFLOW,
			LINT_WORKFLOW,
			MUTATION_WORKFLOW,
		])
			for (const job of Object.values((await readWorkflow(path)).jobs))
				for (const step of job.steps) {
					if (step.uses === undefined) continue;
					// The failure names the workflow and the action.
					expect({
						path,
						uses: step.uses,
						allowed: allowed.has(step.uses),
					}).toEqual({ path, uses: step.uses, allowed: true });
					if (step.uses === "oven-sh/setup-bun@v2")
						expect(step.with).toEqual({ "bun-version": "1.4.2" });
				}
	});
});

describe("secrets and publishing", () => {
	test("no job references a secret outside the five tokens and GITHUB_TOKEN", () => {
		const referenced = [...workflowText.matchAll(/secrets\.(\w+)/g)].map(
			(match) => match[1] ?? "",
		);
		expect(referenced.length).toBeGreaterThan(0);
		for (const name of referenced)
			expect({ name, allowed: ALLOWED_SECRETS.has(name) }).toEqual({
				name,
				allowed: true,
			});
		expect(workflowText).not.toMatch(/secrets\s*\[/);
	});

	test("each registry token is mentioned only in its own publish job: as a boolean in the job's env, and its value in the one step that publishes", () => {
		for (const [name, job] of Object.entries(workflow.jobs)) {
			const own = PUBLISH_JOBS.find((publish) => publish.job === name);
			const jobText = JSON.stringify(job);
			const mentioned = new Set(
				[...jobText.matchAll(/secrets\.(\w+)/g)]
					.map((match) => match[1])
					.filter((secret) => secret !== "GITHUB_TOKEN"),
			);
			expect({
				name,
				githubToken: jobText.includes("secrets.GITHUB_TOKEN"),
			}).toEqual({ name, githubToken: name === "release" });
			expect({ name, mentioned: [...mentioned] }).toEqual({
				name,
				mentioned: own === undefined ? [] : [own.token],
			});
			if (own === undefined) continue;
			// The job's env holds only whether the token is set, never the token.
			expect(job.env).toEqual({
				[own.flag]: `\${{ secrets.${own.token} != '' }}`,
			});
			const value = `\${{ secrets.${own.token} }}`;
			const receiving = job.steps.filter((step) =>
				JSON.stringify(step).includes(value),
			);
			expect({
				name,
				receiving: receiving.map((step) => step.name ?? step.uses),
			}).toEqual({ name, receiving: [own.publishStep] });
		}
	});

	for (const publish of PUBLISH_JOBS) {
		test(`${publish.job} needs release and runs no step unless ${publish.token} is set and the tag is not a prerelease`, () => {
			const job = jobNamed(publish.job);
			expect(needsOf(job)).toContain("release");
			const tokenNotice = job.steps.filter(
				(step) =>
					step.run ===
					`echo "::notice::${publish.registry} token not set; not published"`,
			);
			expect(tokenNotice).toEqual([
				expect.objectContaining({ if: `env.${publish.flag} != 'true'` }),
			]);
			const prereleaseNotice = job.steps.filter(
				(step) =>
					step.run ===
					`echo "::notice::${publish.registry} not published for a prerelease tag"`,
			);
			expect(prereleaseNotice).toEqual([
				expect.objectContaining({ if: "contains(github.ref_name, '-')" }),
			]);
			const working = job.steps.filter(
				(step) =>
					!tokenNotice.includes(step) && !prereleaseNotice.includes(step),
			);
			expect(working.length).toBeGreaterThan(0);
			for (const step of working)
				expect({ step: step.name ?? step.uses, if: step.if }).toEqual({
					step: step.name ?? step.uses,
					if: publishGuard(publish.flag),
				});
		});
	}

	test("the wheels are published with the token in UV_PUBLISH_TOKEN, never on the command line, skipping files PyPI already holds", () => {
		const step = stepNamed(jobNamed("publish-pypi"), "Publish the wheels");
		expect(step.env).toEqual({
			UV_PUBLISH_TOKEN: `\${{ secrets.PYPI_TOKEN }}`,
		});
		expect(scriptOf(step).trim().split("\n")).toEqual([
			"uv publish --check-url https://pypi.org/simple/ assembled/wheels/*.whl",
			"uv publish --check-url https://pypi.org/simple/ assembled/fallbacks/*.whl",
		]);
	});

	test("the Homebrew job commits the rendered formula to albertosca/homebrew-tap", () => {
		const job = jobNamed("publish-homebrew");
		const checkout = stepNamed(job, "Check out the tap");
		expect(checkout.uses).toBe("actions/checkout@v7");
		expect(checkout.with).toEqual({
			repository: "albertosca/homebrew-tap",
			token: `\${{ secrets.HOMEBREW_TAP_TOKEN }}`,
			path: "tap",
		});
		const script = scriptOf(stepNamed(job, "Commit the formula to the tap"));
		expect(script).toContain(
			"cp assembled/homebrew/llm-tests-forge.rb tap/Formula/llm-tests-forge.rb",
		);
		expect(script).toContain("git push");
	});
});

describe("re-running a publish step after a partial publish", () => {
	/** A directory holding executable stand-ins, to put first on the PATH. */
	async function toolsWith(tools: Record<string, string>): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "forge-publish-tools-"));
		for (const [name, script] of Object.entries(tools)) {
			await writeFile(join(directory, name), script);
			await chmod(join(directory, name), 0o755);
		}
		return directory;
	}

	test("npm skips each package whose exact version npm already holds and publishes the rest, main last", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "forge-publish-npm-"));
		for (const [directory, name] of [
			["main", "llm-tests-forge"],
			["darwin-arm64", "@llm-tests-forge/darwin-arm64"],
			["linux-x64", "@llm-tests-forge/linux-x64"],
		] as const) {
			await mkdir(join(workspace, "assembled/npm", directory), {
				recursive: true,
			});
			await writeFile(
				join(workspace, "assembled/npm", directory, "package.json"),
				JSON.stringify({ name, version: "1.2.3" }),
			);
		}
		const calls = join(workspace, "npm-calls.txt");
		// npm view prints the version only when that exact version exists; for a
		// missing version of an existing package it prints nothing and exits 0.
		const tools = await toolsWith({
			npm: [
				"#!/bin/sh",
				`echo "$*" >> "${calls}"`,
				'if [ "$1" = view ]; then',
				'  case "$2" in',
				"  @llm-tests-forge/darwin-arm64@1.2.3) echo 1.2.3 ;;",
				"  llm-tests-forge@1.2.3) exit 0 ;;",
				'  *) echo "npm error code E404" >&2; exit 1 ;;',
				"  esac",
				"fi",
				"",
			].join("\n"),
		});
		const result = runStep(
			scriptOf(
				stepNamed(
					jobNamed("publish-npm"),
					"Publish the platform packages, then the main package",
				),
			),
			workspace,
			{ PATH: `${tools}:${process.env.PATH ?? ""}` },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(
			"@llm-tests-forge/darwin-arm64@1.2.3 is already on npm; skipped",
		);
		const published = (await readFile(calls, "utf8"))
			.split("\n")
			.filter((line) => line.startsWith("publish"));
		expect(published).toEqual([
			"publish --access public assembled/npm/linux-x64",
			"publish --access public assembled/npm/main",
		]);
	}, 120_000);

	test("PyPI gets the platform wheels before the fallback wheel, and a failed platform upload keeps the fallback back", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "forge-publish-pypi-"));
		await mkdir(join(workspace, "assembled/wheels"), { recursive: true });
		await mkdir(join(workspace, "assembled/fallbacks"), { recursive: true });
		for (const name of [
			"a-1.2.3-py3-none-linux.whl",
			"b-1.2.3-py3-none-win.whl",
		])
			await writeFile(join(workspace, "assembled/wheels", name), "wheel\n");
		// The fallback's name sorts before the platform wheels', so only the
		// step's own order can put it last.
		await writeFile(
			join(workspace, "assembled/fallbacks/0-1.2.3-py3-none-any.whl"),
			"wheel\n",
		);
		await writeFile(
			join(workspace, "assembled/fallbacks/0-1.2.3.gem"),
			"gem\n",
		);
		const script = scriptOf(
			stepNamed(jobNamed("publish-pypi"), "Publish the wheels"),
		);
		const calls = join(workspace, "uv-calls.txt");
		const uploading = await toolsWith({
			uv: `#!/bin/sh\necho "$*" >> "${calls}"\n`,
		});
		expect(
			runStep(script, workspace, {
				PATH: `${uploading}:${process.env.PATH ?? ""}`,
			}).exitCode,
		).toBe(0);
		expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
			"publish --check-url https://pypi.org/simple/ assembled/wheels/a-1.2.3-py3-none-linux.whl assembled/wheels/b-1.2.3-py3-none-win.whl",
			"publish --check-url https://pypi.org/simple/ assembled/fallbacks/0-1.2.3-py3-none-any.whl",
		]);
		const refusedCalls = join(workspace, "refused-calls.txt");
		const refusing = await toolsWith({
			uv: `#!/bin/sh\necho "$*" >> "${refusedCalls}"\necho "403 Forbidden" >&2\nexit 1\n`,
		});
		const stopped = runStep(script, workspace, {
			PATH: `${refusing}:${process.env.PATH ?? ""}`,
		});
		expect(stopped.exitCode).toBe(1);
		expect(stopped.output).toContain("403 Forbidden");
		expect((await readFile(refusedCalls, "utf8")).trim().split("\n")).toEqual([
			"publish --check-url https://pypi.org/simple/ assembled/wheels/a-1.2.3-py3-none-linux.whl assembled/wheels/b-1.2.3-py3-none-win.whl",
		]);
	}, 30_000);

	test("gem push pushes the platform gems before the fallback gem", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "forge-publish-gem-"));
		await mkdir(join(workspace, "assembled/gems"), { recursive: true });
		await mkdir(join(workspace, "assembled/fallbacks"), { recursive: true });
		for (const name of [
			"a-1.2.3-x86_64-linux-gnu.gem",
			"b-1.2.3-arm64-darwin.gem",
		])
			await writeFile(join(workspace, "assembled/gems", name), "gem\n");
		await writeFile(
			join(workspace, "assembled/fallbacks/0-1.2.3.gem"),
			"gem\n",
		);
		await writeFile(
			join(workspace, "assembled/fallbacks/0-1.2.3-py3-none-any.whl"),
			"wheel\n",
		);
		const calls = join(workspace, "gem-calls.txt");
		const pushing = await toolsWith({
			gem: `#!/bin/sh\necho "$*" >> "${calls}"\necho "Successfully registered gem: $2"\n`,
		});
		const result = runStep(
			scriptOf(stepNamed(jobNamed("publish-gem"), "Push the gems")),
			workspace,
			{ PATH: `${pushing}:${process.env.PATH ?? ""}` },
		);
		expect(result.exitCode).toBe(0);
		expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
			"push assembled/gems/a-1.2.3-x86_64-linux-gnu.gem",
			"push assembled/gems/b-1.2.3-arm64-darwin.gem",
			"push assembled/fallbacks/0-1.2.3.gem",
		]);
	}, 30_000);

	test("gem push treats RubyGems' refusal to repush a version as a skip, and any other failure stops the step", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "forge-publish-gem-"));
		await mkdir(join(workspace, "assembled/gems"), { recursive: true });
		await mkdir(join(workspace, "assembled/fallbacks"), { recursive: true });
		for (const name of ["a-already.gem", "b-new.gem"])
			await writeFile(join(workspace, "assembled/gems", name), "gem\n");
		await writeFile(
			join(workspace, "assembled/fallbacks/c-fallback.gem"),
			"gem\n",
		);
		const script = scriptOf(
			stepNamed(jobNamed("publish-gem"), "Push the gems"),
		);
		const repushing = await toolsWith({
			gem: [
				"#!/bin/sh",
				'case "$2" in',
				'*already*) echo "Repushing of gem versions is not allowed."; echo "Please use \\`gem yank\\` to remove bad gem releases."; exit 1 ;;',
				'*) echo "Successfully registered gem: $2" ;;',
				"esac",
				"",
			].join("\n"),
		});
		const skipped = runStep(script, workspace, {
			PATH: `${repushing}:${process.env.PATH ?? ""}`,
		});
		expect(skipped.exitCode).toBe(0);
		expect(skipped.output).toContain(
			"assembled/gems/a-already.gem is already on RubyGems; skipped",
		);
		expect(skipped.output).toContain(
			"Successfully registered gem: assembled/gems/b-new.gem",
		);
		const refusing = await toolsWith({
			gem: '#!/bin/sh\necho "Access Denied. Please sign up for an account"\nexit 1\n',
		});
		const stopped = runStep(script, workspace, {
			PATH: `${refusing}:${process.env.PATH ?? ""}`,
		});
		expect(stopped.exitCode).toBe(1);
		expect(stopped.output).toContain("Access Denied");
		expect(stopped.output).not.toContain("b-new.gem");
		expect(stopped.output).not.toContain("c-fallback.gem");
	}, 30_000);
});

describe("the tag-version check", () => {
	const script = scriptOf(
		stepNamed(
			jobNamed("check"),
			"Check that the tag is v plus package.json's version",
		),
	);

	test(`passes on v${FORGE_VERSION}`, () => {
		const result = runStep(script, REPOSITORY, {
			GITHUB_REF_NAME: `v${FORGE_VERSION}`,
		});
		expect(result).toEqual({ exitCode: 0, output: "" });
	}, 30_000);

	test("fails on a tag that is not package.json's version, naming both", () => {
		const result = runStep(script, REPOSITORY, {
			GITHUB_REF_NAME: "v9.9.9",
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("v9.9.9");
		expect(result.output).toContain(`v${FORGE_VERSION}`);
	}, 30_000);
});

describe("the release step", () => {
	const script = scriptOf(
		stepNamed(jobNamed("release"), "Create the GitHub Release"),
	);

	/** Runs the release step with a stand-in `gh` that records its arguments, one per line, after checking each asset exists. */
	async function releaseWith(tag: string): Promise<string[]> {
		const workspace = await mkdtemp(join(tmpdir(), "forge-release-step-"));
		await mkdir(join(workspace, "binaries"));
		for (const target of RELEASE_TARGETS)
			await writeFile(
				join(workspace, "binaries", target.assetName),
				"binary\n",
			);
		await writeFile(join(workspace, "binaries", CHECKSUMS_FILE_NAME), "sums\n");
		await writeFile(join(workspace, "install.sh"), "#!/bin/sh\n");
		const tools = join(workspace, "tools");
		await mkdir(tools);
		const calls = join(workspace, "gh-arguments.txt");
		await writeFile(
			join(tools, "gh"),
			[
				"#!/bin/sh",
				`for argument in "$@"; do printf '%s\\n' "$argument" >> "${calls}"; done`,
				'for argument in "$@"; do case "$argument" in binaries/* | install.sh) [ -f "$argument" ] || exit 9 ;; esac; done',
				"",
			].join("\n"),
		);
		await chmod(join(tools, "gh"), 0o755);
		const result = runStep(script, workspace, {
			GITHUB_REF_NAME: tag,
			PATH: `${tools}:${process.env.PATH ?? ""}`,
		});
		expect(result).toEqual({ exitCode: 0, output: "" });
		return (await readFile(calls, "utf8")).trimEnd().split("\n");
	}

	test("a release tag uploads the five binaries, SHA256SUMS and install.sh, not as a draft", async () => {
		const argumentsList = await releaseWith("v1.2.3");
		expect(argumentsList.slice(0, 3)).toEqual(["release", "create", "v1.2.3"]);
		expect(argumentsList).not.toContain("--draft");
		const assets = argumentsList.filter(
			(argument) =>
				argument.startsWith("binaries/") || argument === "install.sh",
		);
		expect(assets.sort()).toEqual(
			[
				...RELEASE_TARGETS.map((target) => `binaries/${target.assetName}`),
				`binaries/${CHECKSUMS_FILE_NAME}`,
				"install.sh",
			].sort(),
		);
	}, 30_000);

	test("a tag holding a hyphen makes a draft prerelease", async () => {
		const argumentsList = await releaseWith("v0.2.0-rc.1");
		expect(argumentsList).toContain("--draft");
		expect(argumentsList).toContain("--prerelease");
	}, 30_000);

	test("install.sh fetches the asset names the release uploads", async () => {
		const installScript = await readFile(
			join(REPOSITORY, "install.sh"),
			"utf8",
		);
		expect(installScript).toContain(
			'asset_name="$BINARY_NAME-$operating_system-$architecture"',
		);
		expect(installScript).toContain('BINARY_NAME="llm-tests-forge"');
		expect(installScript).toContain('"$base_url/SHA256SUMS"');
		for (const pair of [
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
		])
			expect(RELEASE_TARGETS.map((target) => target.assetName)).toContain(
				`llm-tests-forge-${pair}`,
			);
	});
});

describe("build provenance", () => {
	const release = jobNamed("release");

	test("the release job attests the five binaries and SHA256SUMS, as SLSA build provenance, before the release is created", () => {
		const attest = stepNamed(release, "Attest the release assets");
		expect(attest.uses).toBe("actions/attest@v4");
		expect(attest.id).toBe("attest");
		// subject-path alone: the action's provenance mode, no custom predicate.
		expect(Object.keys(attest.with ?? {})).toEqual(["subject-path"]);
		const subjects = String(attest.with?.["subject-path"] ?? "")
			.trim()
			.split("\n")
			.map((line) => line.trim());
		expect(subjects.sort()).toEqual(
			[
				...RELEASE_TARGETS.map((target) => `binaries/${target.assetName}`),
				`binaries/${CHECKSUMS_FILE_NAME}`,
			].sort(),
		);
		const names = release.steps.map((step) => step.name ?? step.uses);
		const downloaded = release.steps.findIndex(
			(step) => step.uses === "actions/download-artifact@v8",
		);
		expect(downloaded).toBeGreaterThanOrEqual(0);
		expect(names.indexOf("Attest the release assets")).toBeGreaterThan(
			downloaded,
		);
		expect(names.indexOf("Attest the release assets")).toBeLessThan(
			names.indexOf("Create the GitHub Release"),
		);
	});

	test("a failed attestation stops every release but a private repository's prerelease tag, which only warns (Free, Pro and Team plans have no attestations for private repositories)", () => {
		const attest = stepNamed(release, "Attest the release assets");
		expect(attest["continue-on-error"]).toBe(
			`\${{ github.event.repository.private && contains(github.ref_name, '-') }}`,
		);
		expect(release["continue-on-error"]).toBeUndefined();
		// Nothing can skip the attestation, nor create the release without it.
		expect(release.if).toBeUndefined();
		expect(attest.if).toBeUndefined();
		expect(stepNamed(release, "Create the GitHub Release").if).toBeUndefined();
		const warning = stepNamed(release, "Warn that the release is not attested");
		expect(warning.if).toBe("steps.attest.outcome == 'failure'");
		const result = runStep(scriptOf(warning), tmpdir(), {});
		expect(result.exitCode).toBe(0);
		expect(result.output).toStartWith("::warning::");
		expect(result.output).toContain("gh attestation verify");
		// Nothing else in the workflow continues on error.
		for (const [name, job] of Object.entries(workflow.jobs))
			for (const step of job.steps)
				if (step !== attest)
					expect({
						name,
						step: step.name ?? step.uses,
						continueOnError: step["continue-on-error"],
					}).toEqual({
						name,
						step: step.name ?? step.uses,
						continueOnError: undefined,
					});
	});

	test("install.sh verifies against this repository and this workflow file", async () => {
		const installScript = await readFile(
			join(REPOSITORY, "install.sh"),
			"utf8",
		);
		expect(installScript).toContain('REPOSITORY="albertosca/llm-tests-forge"');
		expect(installScript).toContain(
			`SIGNER_WORKFLOW="$REPOSITORY/${RELEASE_WORKFLOW.slice(REPOSITORY.length + 1)}"`,
		);
	});
});

describe("the smoke steps, run here against the source CLI", () => {
	const smoke = jobNamed("smoke");
	const smokeScripts = smoke.steps
		.filter((step) => step.run !== undefined)
		.map((step) => ({ name: step.name ?? "", script: scriptOf(step) }));
	const fixture = smoke.env?.FIXTURE ?? "";
	const asset = "llm-tests-forge-linux-x64";

	test("the job hands the steps the asset and the fixture through env, never through expressions in scripts", () => {
		expect(smoke.env?.ASSET).toBe(`\${{ matrix.asset }}`);
		expect(fixture).toBe("tests/fixtures/extract-questions");
		for (const { script } of smokeScripts) expect(script).not.toContain("${{");
	});

	test("the fixture is checked out byte for byte, so Windows sees the same line endings", async () => {
		const attributes = await readFile(
			join(REPOSITORY, ".gitattributes"),
			"utf8",
		);
		expect(attributes.split("\n")).toContain(`${fixture}/** -text`);
	});

	/** A workspace like the runner's after checkout and download: the fixture, and `binaries/` with a stand-in binary and its SHA256SUMS. */
	async function smokeWorkspace(binaryScript: string): Promise<string> {
		const workspace = await mkdtemp(join(tmpdir(), "forge-smoke-"));
		await cp(join(REPOSITORY, fixture), join(workspace, fixture), {
			recursive: true,
		});
		await mkdir(join(workspace, "binaries"));
		await writeFile(join(workspace, "binaries", asset), binaryScript);
		await writeChecksums(join(workspace, "binaries"));
		return workspace;
	}

	const sourceBinary = [
		"#!/bin/sh",
		`exec bun "${join(REPOSITORY, "src/cli/bin.ts")}" "$@"`,
		"",
	].join("\n");

	function runSmoke(
		workspace: string,
	): { name: string; exitCode: number; output: string }[] {
		const results: { name: string; exitCode: number; output: string }[] = [];
		for (const { name, script } of smokeScripts) {
			const result = runStep(script, workspace, {
				ASSET: asset,
				FIXTURE: fixture,
				GITHUB_REF_NAME: `v${FORGE_VERSION}`,
				// These steps run the forge CLI: it must not read the real
				// ~/.config/*/api.env (see tests/helpers/isolated-home.ts).
				HOME: ISOLATED_HOME,
			});
			results.push({ name, ...result });
			if (result.exitCode !== 0) break;
		}
		return results;
	}

	test("every step passes on a binary that reproduces the committed outputs", async () => {
		const results = runSmoke(await smokeWorkspace(sourceBinary));
		expect(results.map(({ name, exitCode }) => ({ name, exitCode }))).toEqual(
			smokeScripts.map(({ name }) => ({ name, exitCode: 0 })),
		);
	}, 120_000);

	test("a binary whose bytes differ from SHA256SUMS stops at the checksum step", async () => {
		const workspace = await smokeWorkspace(sourceBinary);
		await writeFile(
			join(workspace, "binaries", asset),
			`${sourceBinary}# changed\n`,
		);
		const results = runSmoke(workspace);
		expect(results.at(-1)?.name).toBe("Verify SHA256SUMS");
		expect(results.at(-1)?.exitCode).not.toBe(0);
	}, 30_000);

	test("a binary that reports another version fails", async () => {
		const results = runSmoke(await smokeWorkspace("#!/bin/sh\necho 9.9.9\n"));
		expect(results.at(-1)?.name).toBe("Run --version and --help");
		expect(results.at(-1)?.exitCode).not.toBe(0);
	}, 30_000);

	test("a binary that succeeds without writing anything but the stamp fails the comparison", async () => {
		const results = runSmoke(
			await smokeWorkspace(
				[
					"#!/bin/sh",
					`if [ "$1" = "--version" ]; then echo ${FORGE_VERSION}; fi`,
					`if [ -f .forge/suite.yaml ]; then sed -e 's/^forge_version: .*/forge_version: ${FORGE_VERSION}/' .forge/suite.yaml > suite.stamped && mv suite.stamped .forge/suite.yaml; fi`,
					"exit 0",
					"",
				].join("\n"),
			),
		);
		expect(results.at(-1)?.name).toBe("Compare with the committed outputs");
		expect(results.at(-1)?.exitCode).not.toBe(0);
	}, 120_000);

	test("the copy's stamp starts older than the binary, so every runner rewrites suite.yaml (the one rename onto an existing file) and the binary's version lands", async () => {
		const workspace = await smokeWorkspace("");
		const stamps = join(workspace, "stamps.log");
		// Logs the stamp each call finds in the suite it runs in, then runs the source CLI.
		await writeFile(
			join(workspace, "binaries", asset),
			[
				"#!/bin/sh",
				`if [ -f .forge/suite.yaml ]; then sed -n 's/^forge_version: //p' .forge/suite.yaml >> "${stamps}"; fi`,
				`exec bun "${join(REPOSITORY, "src/cli/bin.ts")}" "$@"`,
				"",
			].join("\n"),
		);
		await writeChecksums(join(workspace, "binaries"));
		const results = runSmoke(workspace);
		expect(results.map(({ name, exitCode }) => ({ name, exitCode }))).toEqual(
			smokeScripts.map(({ name }) => ({ name, exitCode: 0 })),
		);
		// estimate reads only; emit stamps, so report finds the binary's version.
		expect((await readFile(stamps, "utf8")).split("\n")).toEqual([
			"0.0.0",
			"0.0.0",
			FORGE_VERSION,
			"",
		]);
	}, 120_000);

	test("a stamp that does not land (a failed stamp is only a warning) fails the run step, naming both versions", async () => {
		const workspace = await smokeWorkspace("");
		// Runs the source CLI, then puts suite.yaml back as it found it.
		await writeFile(
			join(workspace, "binaries", asset),
			[
				"#!/bin/sh",
				`if [ -f .forge/suite.yaml ]; then cp .forge/suite.yaml "${workspace}/suite.before"; fi`,
				`bun "${join(REPOSITORY, "src/cli/bin.ts")}" "$@"`,
				"status=$?",
				`if [ -f "${workspace}/suite.before" ]; then cp "${workspace}/suite.before" .forge/suite.yaml; fi`,
				'exit "$status"',
				"",
			].join("\n"),
		);
		await writeChecksums(join(workspace, "binaries"));
		const results = runSmoke(workspace);
		expect(results.at(-1)?.name).toBe(
			"Run estimate, emit and report on the fixture suite",
		);
		expect(results.at(-1)?.exitCode).not.toBe(0);
		expect(results.at(-1)?.output).toContain(
			`suite.yaml carries forge_version 0.0.0, not ${FORGE_VERSION}`,
		);
	}, 120_000);

	test("a committed report that differs outside its timestamps fails the comparison", async () => {
		const workspace = await smokeWorkspace(sourceBinary);
		const reportPath = join(workspace, fixture, ".forge/report.json");
		const report = await readFile(reportPath, "utf8");
		const tampered = report.replace(/"matched": \d+/, '"matched": 1');
		expect(tampered).not.toBe(report);
		await writeFile(reportPath, tampered);
		const results = runSmoke(workspace);
		expect(results.at(-1)?.name).toBe("Compare with the committed outputs");
		expect(results.at(-1)?.exitCode).not.toBe(0);
	}, 120_000);
});

describe("the package tests in CI", () => {
	for (const path of [CI_WORKFLOW, RELEASE_WORKFLOW])
		test(`${path.slice(REPOSITORY.length + 1)} has a packages job running test:packages on ubuntu-24.04 with every package toolchain`, async () => {
			const packagesJob = (await readWorkflow(path)).jobs.packages;
			expect(packagesJob?.["runs-on"]).toBe("ubuntu-24.04");
			expect(packagesJob?.permissions).toEqual({ contents: "read" });
			const steps = packagesJob?.steps ?? [];
			expect(steps.map((step) => step.uses ?? step.run)).toEqual([
				"actions/checkout@v7",
				"oven-sh/setup-bun@v2",
				"bun install --frozen-lockfile",
				"actions/setup-node@v7",
				"astral-sh/setup-uv@v10.2.0",
				"ruby/setup-ruby@v1",
				"erlef/setup-beam@v1",
				"mix local.hex --force",
				"bun run test:packages",
			]);
			const withOf = (uses: string) =>
				steps.find((step) => step.uses === uses)?.with;
			expect(withOf("oven-sh/setup-bun@v2")).toEqual({
				"bun-version": "1.4.2",
			});
			expect(withOf("actions/setup-node@v7")).toEqual({ "node-version": "22" });
			// The package tests keep uv's cache in node_modules/.cache/forge-uv
			// (tests/support/preload-package-caches.ts), so setup-uv's own cache
			// would be restored for nothing.
			expect(withOf("astral-sh/setup-uv@v10.2.0")).toEqual({
				"enable-cache": false,
			});
			expect(withOf("ruby/setup-ruby@v1")).toEqual({ "ruby-version": "3.3" });
			expect(withOf("erlef/setup-beam@v1")).toEqual({
				"otp-version": "27",
				"elixir-version": "1.18",
			});
		});

	test("every publish job needs the packages job, so nothing is published past a red package test", () => {
		for (const publish of PUBLISH_JOBS)
			expect({
				job: publish.job,
				needsPackages: needsOf(jobNamed(publish.job)).includes("packages"),
			}).toEqual({ job: publish.job, needsPackages: true });
	});

	test("the GitHub Release needs the packages job too, so a red package test holds back the binaries, SHA256SUMS and install.sh", () => {
		expect(needsOf(jobNamed("release"))).toContain("packages");
	});
});

describe("the Ruby lint in CI", () => {
	test("lint.yml has a job that runs lint:ruby after setting up Ruby and rubocop", async () => {
		const lint = await readWorkflow(LINT_WORKFLOW);
		const rubyJobs = Object.values(lint.jobs).filter((job) =>
			job.steps.some((step) => step.run === "bun run lint:ruby"),
		);
		expect(rubyJobs).toHaveLength(1);
		const [rubyJob] = rubyJobs;
		expect(rubyJob?.steps.map((step) => step.uses ?? step.run)).toEqual(
			expect.arrayContaining([
				"ruby/setup-ruby@v1",
				"gem install rubocop -v 1.91.0",
				"bun run lint:ruby",
			]),
		);
	});

	for (const { script, command, setup } of [
		{
			script: "lint:elixir",
			command: "cd packages/hex && mix format --check-formatted",
			setup: "erlef/setup-beam@v1",
		},
		{
			script: "lint:python",
			command: "uvx ruff@0.16.9 format --check packages/pypi",
			setup: "astral-sh/setup-uv@v10.2.0",
		},
	])
		test(`lint.yml has a job that runs ${script} (${command}) after ${setup}`, async () => {
			const manifest = JSON.parse(
				await readFile(join(REPOSITORY, "package.json"), "utf8"),
			);
			expect(manifest.scripts[script]).toBe(command);
			const lint = await readWorkflow(LINT_WORKFLOW);
			const jobs = Object.values(lint.jobs).filter((job) =>
				job.steps.some((step) => step.run === `bun run ${script}`),
			);
			expect(jobs).toHaveLength(1);
			const steps = jobs[0]?.steps.map((step) => step.uses ?? step.run) ?? [];
			expect(steps.indexOf(setup)).toBeGreaterThanOrEqual(0);
			expect(steps.indexOf(setup)).toBeLessThan(
				steps.indexOf(`bun run ${script}`),
			);
		});

	test("the Hex package has a formatter config covering lib, test and mix.exs", async () => {
		expect(
			await readFile(join(REPOSITORY, "packages/hex/.formatter.exs"), "utf8"),
		).toContain('inputs: ["{mix,.formatter}.exs", "{lib,test}/**/*.{ex,exs}"]');
	});
});

describe("the mutation workflow", () => {
	const TriggersSchema = z.object({
		workflow_dispatch: z.unknown(),
		schedule: z.array(z.object({ cron: z.string() })),
		pull_request: z.object({ paths: z.array(z.string()) }),
	});

	test("it runs on demand, weekly, and on pull requests touching src, the tests, the Stryker config and its tsconfig, its TypeScript resolve hook and scopes, or the workflow itself", async () => {
		const mutation = await readWorkflow(MUTATION_WORKFLOW);
		const triggers = TriggersSchema.parse(mutation.on);
		expect(Object.keys(triggers).sort()).toEqual([
			"pull_request",
			"schedule",
			"workflow_dispatch",
		]);
		expect(triggers.schedule).toHaveLength(1);
		expect(triggers.pull_request.paths).toEqual([
			"src/**",
			"tests/**",
			"stryker.config.mjs",
			"tsconfig.stryker.json",
			"scripts/mutation/**",
			".github/workflows/mutation.yml",
		]);
	});

	// The time limit of each scope's job, in minutes, sized from the CPU time
	// measured on 2026-10-06 (the comment in mutation.yml has the numbers).
	// Changing one is a decision.
	const SCOPE_TIMEOUTS = {
		core: 60,
		cli: 60,
		emit: 20,
		report: 20,
		llm: 20,
	};

	test("one job per mutation scope, none cancelling the others, each with the time limit measured for it", async () => {
		const mutation = await readWorkflow(MUTATION_WORKFLOW);
		const jobs = Object.values(mutation.jobs);
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		expect(job?.strategy?.["fail-fast"]).toBe(false);
		const include = job?.strategy?.matrix.include ?? [];
		expect(
			Object.fromEntries(include.map((entry) => [entry.scope, entry.timeout])),
		).toEqual(SCOPE_TIMEOUTS);
		// A scope added to scopes.mjs without a job here would never run in CI.
		expect(include.map((entry) => entry.scope).sort()).toEqual(
			[...SCOPE_NAMES].sort(),
		);
		expect(job?.["timeout-minutes"]).toBe(`\${{ matrix.timeout }}`);
		expect(job?.["runs-on"]).toBe("ubuntu-24.04");
	});

	test("nothing silences the gate: no job or step continues on error, and each scope's report uploads even when its gate fails", async () => {
		const mutation = await readWorkflow(MUTATION_WORKFLOW);
		const jobs = Object.values(mutation.jobs);
		for (const job of jobs) {
			expect(job["continue-on-error"]).toBeUndefined();
			for (const step of job.steps)
				expect(step["continue-on-error"]).toBeUndefined();
		}
		const upload = jobs[0]?.steps.find(
			(step) => step.uses === "actions/upload-artifact@v7",
		);
		expect(upload?.if).toBe("always()");
	});

	test("its job installs from the lockfile with bun and node, runs bun run mutation for its own scope, and uploads reports/mutation/ under a name of its own", async () => {
		const mutation = await readWorkflow(MUTATION_WORKFLOW);
		expect(mutation.permissions).toEqual({ contents: "read" });
		const jobs = Object.values(mutation.jobs);
		expect(jobs).toHaveLength(1);
		const steps = jobs[0]?.steps ?? [];
		expect(steps.map((step) => step.uses ?? step.run)).toEqual([
			"actions/checkout@v7",
			"oven-sh/setup-bun@v2",
			"actions/setup-node@v7",
			"bun install --frozen-lockfile",
			'bun run mutation "$SCOPE"',
			"actions/upload-artifact@v7",
		]);
		expect(steps[1]?.with).toEqual({ "bun-version": "1.4.2" });
		// The scope reaches the shell through the environment, never spliced
		// into the script text.
		expect(steps[4]?.env).toEqual({ SCOPE: `\${{ matrix.scope }}` });
		expect(steps[5]?.with).toEqual({
			name: `mutation-report-\${{ matrix.scope }}`,
			path: "reports/mutation/",
		});
	});

	test("the mutation script runs Stryker under node with the TypeScript resolve hook, and is never part of check", async () => {
		const manifest = JSON.parse(
			await readFile(join(REPOSITORY, "package.json"), "utf8"),
		);
		// The runner takes the scope as its argument and starts Stryker with
		// the hook (scripts/mutation/run.mjs); `mutation:all` runs every scope.
		expect(manifest.scripts.mutation).toBe("node scripts/mutation/run.mjs");
		expect(manifest.scripts["mutation:all"]).toBe(
			"node scripts/mutation/run-all.mjs",
		);
		expect(manifest.scripts.check).not.toContain("mutation");
	});
});

const actionlint = Bun.which("actionlint");
test.skipIf(actionlint === null)(
	`actionlint accepts release.yml, lint.yml, ci.yml and mutation.yml${actionlint === null ? " (skipped: actionlint is not installed on this machine)" : ""}`,
	() => {
		const child = Bun.spawnSync(
			[
				actionlint ?? "actionlint",
				RELEASE_WORKFLOW,
				LINT_WORKFLOW,
				CI_WORKFLOW,
				MUTATION_WORKFLOW,
			],
			{ cwd: REPOSITORY },
		);
		expect(child.stdout.toString()).toBe("");
		expect(child.exitCode).toBe(0);
	},
);
