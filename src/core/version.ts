import packageJson from "../../package.json" with { type: "json" };

/** The installed forge's version, embedded at build time from package.json. */
export const FORGE_VERSION: string = packageJson.version;

export type VersionRelation = "same" | "patch" | "older" | "newer";

/** `major.minor.patch` with any `-suffix` ignored; null when it is not that shape. */
function parseVersion(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * How the version that wrote a suite (`stamp`) stands against the installed
 * one, by major and minor: `older` and `newer` are the stamp's place, `patch`
 * is a difference in the patch number alone, and a stamp that is not
 * `major.minor.patch` is `older` (it cannot be trusted to be current).
 */
export function compareVersions(
	stamp: string,
	installed: string,
): VersionRelation {
	const stamped = parseVersion(stamp);
	const current = parseVersion(installed);
	if (stamped === null || current === null) return "older";
	for (const position of [0, 1] as const) {
		const difference = stamped[position] - current[position];
		if (difference < 0) return "older";
		if (difference > 0) return "newer";
	}
	return stamped[2] === current[2] ? "same" : "patch";
}

/**
 * True when `candidate` is a higher `major.minor.patch` than `existing`
 * (patch included, unlike `compareVersions`). Anything that is not that
 * shape counts as lowest, so a garbled stamp is always replaceable.
 */
export function isHigherVersion(candidate: string, existing: string): boolean {
	const higher = parseVersion(candidate);
	const lower = parseVersion(existing);
	if (higher === null) return false;
	if (lower === null) return true;
	for (const position of [0, 1, 2] as const)
		if (higher[position] !== lower[position])
			return higher[position] > lower[position];
	return false;
}

/** The warning a suite's stamp earns against the installed version, or null. */
export function versionWarning(
	stamp: string | undefined,
	installed: string,
): string | null {
	if (stamp === undefined) return null;
	const relation = compareVersions(stamp, installed);
	if (relation === "older")
		return `warning: this suite was written by llm-tests-forge ${stamp}; installed is ${installed}`;
	if (relation === "newer")
		return `warning: this suite was written by llm-tests-forge ${stamp}, newer than the installed ${installed}; upgrade llm-tests-forge before changing it`;
	return null;
}
