import { join } from "node:path";
import { UsageError } from "./errors";
import {
	backslashProblem,
	comparableEntry,
	findProjectRoot,
	type Project,
	readProject,
	registeredSuiteNames,
	registrationHint,
} from "./project";

export interface Resolution {
	forgeDirectory: string;
	project: Project | null;
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
	if (options.suite.includes("\\"))
		throw new UsageError(backslashProblem(options.suite));
	const project = await readProject(root);
	const wanted = comparableEntry(options.suite);
	const found = project.suites.find(
		(suite) => comparableEntry(suite.entry) === wanted,
	);
	if (found === undefined)
		throw new UsageError(
			`suite "${options.suite}" is not registered in ${project.file}; registered: ${registeredSuiteNames(project)}. If it exists, ${registrationHint(options.suite)}`,
		);
	return { forgeDirectory: join(found.directory, ".forge"), project };
}
