/**
 * Every target kind, end to end: a one-function application in the
 * language, a forged suite, `emit`, the stub line of the written shim
 * replaced by the real call, and promptfoo 0.123.0 running it. Off by
 * default; run with `bun run test:shims` (sets FORGE_SHIMS=1). It needs
 * python3, node, ruby, elixir (1.18+), cargo and go on the PATH, and the
 * network for serde_json and promptfoo the first time.
 */
import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	writeCases,
	writeFeature,
	writeScenarios,
	writeSuite,
} from "../../src/core/files";
import type { Suite } from "../../src/core/schemas";

const shims = process.env.FORGE_SHIMS === "1";
const REPOSITORY = resolve(import.meta.dir, "../..");
const STUB = "call your application here";

interface Finished {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runIn(directory: string, command: string[]): Promise<Finished> {
	const child = Bun.spawn(command, {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PROMPTFOO_DISABLE_TELEMETRY: "1",
			PROMPTFOO_DISABLE_UPDATE: "1",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function mustRun(directory: string, command: string[]): Promise<void> {
	const finished = await runIn(directory, command);
	if (finished.exitCode !== 0)
		throw new Error(
			`${command.join(" ")} exited ${finished.exitCode} in ${directory}\n${finished.stdout}\n${finished.stderr}`,
		);
}

/** Writes each file, creating its directory; paths are relative to `root`. */
async function writeFiles(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(resolve(target, ".."), { recursive: true });
		await writeFile(target, content);
	}
}

/** Swaps text in a written shim file, failing loudly when the text is not there. */
async function replaceIn(
	path: string,
	from: string,
	replacement: string,
): Promise<void> {
	const text = await readFile(path, "utf8");
	if (!text.includes(from)) throw new Error(`"${from}" not found in ${path}`);
	await writeFile(path, text.replace(from, replacement));
}

/** Replaces the whole stub line, keeping its indentation, with `call`. */
async function fillStub(path: string, call: string): Promise<void> {
	const lines = (await readFile(path, "utf8")).split("\n");
	const index = lines.findIndex((line) => line.includes(STUB));
	if (index < 0) throw new Error(`no stub line in ${path}`);
	const indentation = /^\s*/.exec(lines[index] ?? "")?.[0] ?? "";
	lines[index] = `${indentation}${call}`;
	await writeFile(path, lines.join("\n"));
}

async function forgeSuite(
	suiteDirectory: string,
	target: Suite["target"],
): Promise<void> {
	const forgeDirectory = join(suiteDirectory, ".forge");
	await writeFeature(forgeDirectory, {
		id: "shout",
		purpose: "Shout the text back",
		inputs: [{ name: "text", kind: "text" }],
		output: { kind: "label", labels: ["HELLO"] },
		invariants: [],
		status: "approved",
	});
	await writeScenarios(forgeDirectory, [
		{
			id: "greeting",
			kind: "happy",
			oracle: "label",
			description: "a greeting comes back upper-cased",
			status: "approved",
		},
	]);
	await writeCases(forgeDirectory, "greeting", [
		{
			id: "greeting-01",
			scenario: "greeting",
			input: { text: "hello" },
			expected: { label: "HELLO" },
			status: "approved",
			generated_by: "tests/shims",
		},
	]);
	await writeSuite(forgeDirectory, {
		target,
		judges: ["fake/none"],
		repeat: 1,
		include: [],
	});
}

interface PromptfooRow {
	success: boolean;
	error?: string | null;
	response?: { output?: unknown; error?: string };
}

/** Runs promptfoo from the suite directory and returns its rows, with the run's own output for failure messages. */
async function promptfooRows(
	suiteDirectory: string,
): Promise<{ finished: Finished; rows: PromptfooRow[] }> {
	const finished = await runIn(suiteDirectory, [
		"bunx",
		"promptfoo@0.123.0",
		"eval",
		"-c",
		".forge/promptfooconfig.yaml",
		"-o",
		"results.json",
		"--no-cache",
		"--no-progress-bar",
	]);
	const results = JSON.parse(
		await readFile(join(suiteDirectory, "results.json"), "utf8").catch(
			() => "{}",
		),
	);
	return { finished, rows: results?.results?.results ?? [] };
}

async function expectOnePassingHello(suiteDirectory: string): Promise<void> {
	const { finished, rows } = await promptfooRows(suiteDirectory);
	const shown = `exit ${finished.exitCode}\n${finished.stdout.slice(-3000)}\n${finished.stderr.slice(-3000)}\n${JSON.stringify(rows, null, 1).slice(0, 3000)}`;
	// A red run prints what promptfoo said, not only its exit status.
	if (finished.exitCode !== 0 || rows[0]?.response?.output !== "HELLO")
		throw new Error(shown);
	expect(rows.length).toBe(1);
	expect(rows[0]?.response?.output).toBe("HELLO");
	expect(rows[0]?.success).toBe(true);
}

interface Project {
	project: string;
	suite: string;
	forge: string;
}

/**
 * A temporary project with its suite at evals/shout/, emitted, handed to
 * `body` and removed afterwards, pass or fail (with its Cargo target/).
 */
async function withProject(
	target: Suite["target"],
	application: Record<string, string>,
	body: (project: Project) => Promise<void>,
): Promise<void> {
	const project = await realpath(await mkdtemp(join(tmpdir(), "forge-shim-")));
	try {
		const suite = join(project, "evals", "shout");
		await writeFiles(project, application);
		await forgeSuite(suite, target);
		await mustRun(suite, [
			process.execPath,
			join(REPOSITORY, "src/cli/bin.ts"),
			"emit",
		]);
		await body({ project, suite, forge: join(suite, ".forge") });
	} finally {
		await rm(project, { recursive: true, force: true });
	}
}

/**
 * The model the suite names. Each filled-in shim answers HELLO only when
 * this model reached it, and "model was <what arrived>" otherwise, so every
 * passing kind also proves the model travels from suite.yaml to the shim.
 */
const MODEL = "fake/model-probe";
const MODELS = [MODEL];

const ELIXIR_PROJECT = {
	"mix.exs":
		'defmodule App.MixProject do\n  use Mix.Project\n\n  def project, do: [app: :app, version: "0.1.0", deps: []]\nend\n',
	"lib/app.ex":
		"defmodule App do\n  def shout(text), do: String.upcase(text)\nend\n",
};
const ELIXIR_CALL = `if _model == "${MODEL}", do: App.shout(Map.fetch!(_inputs, "text")), else: "model was " <> _model`;

describe.skipIf(!shims)("every target kind against promptfoo 0.123.0", () => {
	test("python", async () => {
		await withProject(
			{ kind: "python", models: MODELS },
			{ "app.py": "def shout(text):\n    return text.upper()\n" },
			async ({ project, suite, forge }) => {
				await fillStub(
					join(forge, "forge_target.py"),
					`import sys; sys.path.insert(0, ${JSON.stringify(project)}); from app import shout; return {"output": shout(inputs["text"]) if model == "${MODEL}" else "model was " + model}`,
				);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("javascript", async () => {
		await withProject(
			{ kind: "javascript", models: MODELS },
			{
				"app.mjs":
					"export function shout(text) {\n\treturn text.toUpperCase();\n}\n",
			},
			async ({ suite, forge }) => {
				await fillStub(
					join(forge, "forge_target.mjs"),
					`const { shout } = await import("../../../app.mjs"); return { output: model === "${MODEL}" ? shout(inputs.text) : "model was " + model };`,
				);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("typescript", async () => {
		await withProject(
			{ kind: "typescript", models: MODELS },
			{
				"app.ts":
					"export function shout(text: string): string {\n\treturn text.toUpperCase();\n}\n",
			},
			async ({ suite, forge }) => {
				await fillStub(
					join(forge, "forge_target.ts"),
					`const { shout } = await import("../../../app.ts"); return { output: model === "${MODEL}" ? shout(inputs.text ?? "") : "model was " + model };`,
				);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("elixir", async () => {
		// Not compiled beforehand, as a project just edited is not: the first
		// case compiles it, and its output must not reach the assert.
		await withProject(
			{ kind: "elixir", models: MODELS },
			ELIXIR_PROJECT,
			async ({ suite, forge }) => {
				await fillStub(join(forge, "forge_target.exs"), ELIXIR_CALL);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("elixir, with an application that logs as it starts and as it answers", async () => {
		// Logger's default handler writes to standard output under mix run.
		await withProject(
			{ kind: "elixir", models: MODELS },
			{
				"mix.exs":
					'defmodule App.MixProject do\n  use Mix.Project\n\n  def project, do: [app: :app, version: "0.1.0", deps: []]\n  def application, do: [mod: {App.Application, []}, extra_applications: [:logger]]\nend\n',
				"lib/application.ex":
					'defmodule App.Application do\n  use Application\n  require Logger\n\n  def start(_type, _args) do\n    Logger.warning("start-up log line")\n    Supervisor.start_link([], strategy: :one_for_one)\n  end\nend\n',
				"lib/app.ex":
					'defmodule App do\n  require Logger\n\n  def shout(text) do\n    Logger.warning("app log line")\n    String.upcase(text)\n  end\nend\n',
			},
			async ({ suite, forge }) => {
				await fillStub(join(forge, "forge_target.exs"), ELIXIR_CALL);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("ruby", async () => {
		await withProject(
			{ kind: "ruby", models: MODELS },
			{ "app.rb": "def shout(text)\n  text.upcase\nend\n" },
			async ({ suite, forge }) => {
				await fillStub(
					join(forge, "forge_target.rb"),
					`require_relative "../../../app"; model == "${MODEL}" ? shout(inputs["text"]) : "model was " + model`,
				);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("rust", async () => {
		await withProject(
			{ kind: "rust", models: MODELS },
			{
				"Cargo.toml":
					'[package]\nname = "my_app"\nversion = "0.1.0"\nedition = "2021"\n',
				"src/lib.rs":
					"pub fn shout(text: &str) -> String {\n    text.to_uppercase()\n}\n",
			},
			async ({ suite, forge }) => {
				const crate = join(forge, "forge_target");
				await replaceIn(
					join(crate, "Cargo.toml"),
					'# my_app = { path = "../../../.." }',
					'my_app = { path = "../../../.." }',
				);
				await fillStub(
					join(crate, "src", "main.rs"),
					`if model == "${MODEL}" { Ok(Value::String(my_app::shout(inputs["text"].as_str().unwrap_or("")))) } else { Ok(Value::String(format!("model was {model}"))) }`,
				);
				await mustRun(crate, ["cargo", "build", "--release", "--quiet"]);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("go, under a go.work at the project root", async () => {
		await withProject(
			{ kind: "go", models: MODELS },
			{
				"go.mod": "module example.com/myapp\n\ngo 1.22\n",
				"go.work": "go 1.22\n\nuse .\n",
				"shout.go":
					'package myapp\n\nimport "strings"\n\nfunc Shout(text string) string {\n\treturn strings.ToUpper(text)\n}\n',
			},
			async ({ suite, forge }) => {
				const module = join(forge, "forge_target");
				await replaceIn(
					join(module, "go.mod"),
					"// require example.com/myapp v0.0.0\n// replace example.com/myapp => ../../../..",
					"require example.com/myapp v0.0.0\nreplace example.com/myapp => ../../../..",
				);
				await replaceIn(
					join(module, "main.go"),
					'\t"errors"\n',
					'\t"example.com/myapp"\n',
				);
				await fillStub(
					join(module, "main.go"),
					`if model != "${MODEL}" { return "model was " + model, nil }; return myapp.Shout(inputs["text"]), nil`,
				);
				// The build command emit prints and the templates name.
				await mustRun(module, [
					"env",
					"GOWORK=off",
					"go",
					"build",
					"-o",
					"forge_target",
					".",
				]);
				await expectOnePassingHello(suite);
			},
		);
	});

	test("http", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				const text =
					typeof body === "object" &&
					body !== null &&
					"text" in body &&
					typeof body.text === "string"
						? body.text
						: "";
				return Response.json({ result: text.toUpperCase() });
			},
		});
		try {
			await withProject(
				{
					kind: "http",
					url: `http://127.0.0.1:${server.port}/shout`,
					response: "json.result",
					models: MODELS,
				},
				{},
				async ({ suite }) => {
					await expectOnePassingHello(suite);
				},
			);
		} finally {
			server.stop(true);
		}
	});
});
