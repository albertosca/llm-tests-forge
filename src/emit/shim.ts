import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ForgeError } from "../core/errors";
import type { Feature } from "../core/schemas";
import type { ShimKind } from "../core/target";
import { loadTemplate, render } from "../llm/templates";

/** One file of a shim, its path relative to `.forge/`. */
export interface ShimFile {
	path: string;
	content: string;
}

/**
 * Where the shim lives and the project manifest it builds against (mix.exs,
 * Cargo.toml or go.mod), found by walking up from the suite directory.
 */
export interface ShimLocations {
	forgeDirectory: string;
	manifestDirectory: string | null;
	manifestText: string | null;
}

/** The manifest each kind needs from the project; the other kinds need none. */
export const MANIFESTS: Partial<Record<ShimKind, string>> = {
	elixir: "mix.exs",
	rust: "Cargo.toml",
	go: "go.mod",
};

const UNKNOWN_CRATE = "your_crate";
const UNKNOWN_CRATE_PATH = "path/to/your/crate";
const UNKNOWN_GO_MODULE = "example.com/your/module";
const UNKNOWN_MODULE_PATH = "path/to/your/module";

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/** The nearest directory at or above `start` that holds `manifest`, or null at the filesystem root. */
export async function findManifestDirectory(
	start: string,
	manifest: string,
): Promise<string | null> {
	let directory = resolve(start);
	for (;;) {
		if (await exists(join(directory, manifest))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

/** Finds the manifest `kind` needs, searching from the suite directory (the parent of `.forge/`). */
export async function shimLocations(
	kind: ShimKind,
	forgeDirectory: string,
): Promise<ShimLocations> {
	const manifest = MANIFESTS[kind];
	const manifestDirectory =
		manifest === undefined
			? null
			: await findManifestDirectory(dirname(forgeDirectory), manifest);
	if (manifest === undefined || manifestDirectory === null)
		return { forgeDirectory, manifestDirectory: null, manifestText: null };
	return {
		forgeDirectory,
		manifestDirectory,
		manifestText: await readFile(join(manifestDirectory, manifest), "utf8"),
	};
}

function forwardSlashes(path: string): string {
	return path.split(sep).join("/");
}

/** From the shim's own directory (`.forge/<entry>`) to the project manifest's, for a path dependency. */
function pathFromShim(
	entry: string,
	locations: ShimLocations,
	unknown: string,
): string {
	if (locations.manifestDirectory === null) return unknown;
	return forwardSlashes(
		relative(
			join(locations.forgeDirectory, entry),
			locations.manifestDirectory,
		),
	);
}

function isTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `package.name` of Cargo.toml, parsed as TOML so every spelling of the
 * table (`[ package ]`, `["package"]`, `package.name = ...`) reads the same.
 * Null for a workspace with no package of its own, whose directory is no
 * crate to depend on, for an empty name, and for text that is not TOML.
 */
function crateName(manifestText: string | null): string | null {
	if (manifestText === null) return null;
	let manifest: unknown;
	try {
		manifest = Bun.TOML.parse(manifestText);
	} catch {
		return null;
	}
	const packageTable = isTable(manifest) ? manifest.package : undefined;
	const name = isTable(packageTable) ? packageTable.name : undefined;
	return typeof name === "string" && name !== "" ? name : null;
}

function goModule(manifestText: string | null): string {
	const found = /^module\s+"?([^"\s]+)"?/m.exec(manifestText ?? "");
	return found?.[1] ?? UNKNOWN_GO_MODULE;
}

function quotedList(feature: Feature): string {
	return feature.inputs.map((input) => JSON.stringify(input.name)).join(", ");
}

/**
 * The files the person fills in to reach their application. Written once
 * by `emit` and never overwritten; paths are relative to `.forge/`.
 */
export function shimFiles(
	feature: Feature,
	kind: ShimKind,
	entry: string,
	locations: ShimLocations,
): ShimFile[] {
	const names = quotedList(feature);
	const common = { feature_id: feature.id, input_names: `[${names}]` };
	const one = (template: string): ShimFile[] => [
		{ path: entry, content: render(loadTemplate(template), common) },
	];
	switch (kind) {
		case "python":
		case "javascript":
		case "typescript":
		case "elixir":
		case "ruby":
			return one(`shims/${kind}`);
		case "rust": {
			const crate = crateName(locations.manifestText);
			const variables = {
				...common,
				input_names: `&[${names}]`,
				crate_name: crate ?? UNKNOWN_CRATE,
				crate_path:
					crate === null
						? UNKNOWN_CRATE_PATH
						: pathFromShim(entry, locations, UNKNOWN_CRATE_PATH),
			};
			return [
				{
					path: `${entry}/Cargo.toml`,
					content: render(loadTemplate("shims/rust.Cargo.toml"), variables),
				},
				{
					path: `${entry}/src/main.rs`,
					content: render(loadTemplate("shims/rust.main.rs"), variables),
				},
			];
		}
		case "go": {
			const variables = {
				...common,
				input_names: `[]string{${names}}`,
				go_module: goModule(locations.manifestText),
				module_path: pathFromShim(entry, locations, UNKNOWN_MODULE_PATH),
			};
			return [
				{
					path: `${entry}/go.mod`,
					content: render(loadTemplate("shims/go.mod"), variables),
				},
				{
					path: `${entry}/main.go`,
					content: render(loadTemplate("shims/go.main.go"), variables),
				},
			];
		}
	}
}

/**
 * Sets the Logger application's `default_handler` before the application
 * starts; a value the person already exports stays in front of it.
 */
const ELIXIR_LOGS_TO_STDERR =
	'ELIXIR_ERL_OPTIONS="$ELIXIR_ERL_OPTIONS -logger default_handler [{config,#{type=>standard_error}}]"';

/** Characters the double-quoted paths inside `sh -c '...'` cannot carry as they are. */
const UNQUOTABLE = /['"`$\\]/;

/**
 * The exec command promptfoo runs, from `.forge/` (the config's directory).
 * python, javascript and typescript load natively and need none. elixir
 * runs through `mix run`, which only finds the project from its root;
 * both settings keep text out of standard output, where promptfoo reads
 * the answer. MIX_QUIET=1 silences the "Compiling 1 file" lines of a project
 * not yet compiled, and ELIXIR_LOGS_TO_STDERR sends Logger's default handler,
 * which writes to standard output, to standard error from the start, so the
 * application's start-up logs are covered too (measured on Elixir 1.20:
 * without them the first case failed with those lines in its output).
 */
export function targetCommand(
	kind: ShimKind,
	entry: string,
	locations: ShimLocations,
): string | undefined {
	switch (kind) {
		case "python":
		case "javascript":
		case "typescript":
			return undefined;
		case "ruby":
			return `ruby ${entry}`;
		case "rust":
			return `./${entry}/target/release/forge_target`;
		case "go":
			return `./${entry}/forge_target`;
	}
	const { forgeDirectory, manifestDirectory } = locations;
	if (manifestDirectory === null)
		throw new ForgeError(
			`no mix.exs above ${dirname(forgeDirectory)}; an elixir target runs through mix run from the mix project`,
			{ file: forgeDirectory },
		);
	const toProject = forwardSlashes(relative(forgeDirectory, manifestDirectory));
	const toShim = forwardSlashes(
		relative(manifestDirectory, join(forgeDirectory, entry)),
	);
	if (UNQUOTABLE.test(toProject) || UNQUOTABLE.test(toShim))
		throw new ForgeError(
			`the path from the mix project to ${entry} cannot be quoted in the exec command; rename the directories holding a quote, $, \` or \\`,
			{ file: forgeDirectory },
		);
	return `sh -c 'cd "${toProject}" && MIX_QUIET=1 ${ELIXIR_LOGS_TO_STDERR} mix run "${toShim}" "$@"' forge_target`;
}
