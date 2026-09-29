import { join, posix } from "node:path";
import { UsageError } from "./errors";
import {
	findProjectRoot,
	type Project,
	readProject,
	registeredSuiteNames,
} from "./project";

export interface Resolution {
	forgeDirectory: string;
	project: Project | null;
}

/** The form two suite paths are compared in: normalized, without a trailing slash. */
function comparablePath(path: string): string {
	const normalized = posix.normalize(path.split("\\").join("/"));
	return normalized.length > 1 && normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
}

/**
 * Which `.forge` a verb works on. With no `suite`, the current directory's
 * (the project, if any, is the forge.yaml above it). With `suite`, the
 * registered entry of the project above `cwd`, whatever the directory.
 */
export async function resolveSuite(options: {
	cwd: string;
	suite?: string;
}): Promise<Resolution> {
	const root = await findProjectRoot(options.cwd);
	if (options.suite === undefined) {
		return {
			forgeDirectory: join(options.cwd, ".forge"),
			project: root === null ? null : await readProject(root),
		};
	}
	if (root === null)
		throw new UsageError(
			`--suite needs a forge.yaml; none found above ${options.cwd}`,
		);
	const project = await readProject(root);
	const wanted = comparablePath(options.suite);
	const found = project.suites.find(
		(suite) => comparablePath(suite.entry) === wanted,
	);
	if (found === undefined)
		throw new UsageError(
			`suite "${options.suite}" is not registered in ${project.file}; registered: ${registeredSuiteNames(project)}`,
		);
	return { forgeDirectory: join(found.directory, ".forge"), project };
}
