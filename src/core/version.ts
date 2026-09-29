import packageJson from "../../package.json" with { type: "json" };

/** The installed forge's version, embedded at build time from package.json. */
export const FORGE_VERSION: string = packageJson.version;

export type VersionRelation = "same" | "patch" | "older" | "newer";

interface ParsedVersion {
	core: [number, number, number];
	/** The dot-separated identifiers after `-`; empty for a release. */
	prerelease: string[];
}

/** `major.minor.patch` with an optional `-prerelease`; null when it is not that shape. */
function parseVersion(version: string): ParsedVersion | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

/**
 * Semver precedence of two prereleases: a release (no identifiers) is above
 * any prerelease of it, numeric identifiers compare as numbers and sit below
 * alphanumeric ones, and a longer list wins when the shared part is equal.
 * Negative when `left` is lower, positive when higher, 0 when equal.
 */
function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0)
		return right.length - left.length;
	const shared = Math.min(left.length, right.length);
	for (let position = 0; position < shared; position++) {
		const leftIdentifier = left[position] ?? "";
		const rightIdentifier = right[position] ?? "";
		const leftNumeric = /^\d+$/.test(leftIdentifier);
		const rightNumeric = /^\d+$/.test(rightIdentifier);
		if (leftNumeric && rightNumeric) {
			const difference = Number(leftIdentifier) - Number(rightIdentifier);
			if (difference !== 0) return difference;
		} else if (leftNumeric !== rightNumeric) {
			return leftNumeric ? -1 : 1;
		} else if (leftIdentifier !== rightIdentifier) {
			return leftIdentifier < rightIdentifier ? -1 : 1;
		}
	}
	return left.length - right.length;
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
		const difference = stamped.core[position] - current.core[position];
		if (difference < 0) return "older";
		if (difference > 0) return "newer";
	}
	if (stamped.core[2] !== current.core[2]) return "patch";
	// Same major.minor.patch: only the prerelease can differ. A stamp below the
	// installed one (a beta under its release) is the same release line, so it
	// is silent; a stamp above it (the release under a beta) says to upgrade.
	const difference = comparePrerelease(stamped.prerelease, current.prerelease);
	if (difference === 0) return "same";
	return difference < 0 ? "patch" : "newer";
}

/**
 * True when `candidate` is a higher version than `existing` (patch and
 * prerelease included, unlike `compareVersions`; a release is above its
 * prereleases). Anything that is not that
 * shape counts as lowest, so a garbled stamp is always replaceable.
 */
export function isHigherVersion(candidate: string, existing: string): boolean {
	const higher = parseVersion(candidate);
	const lower = parseVersion(existing);
	if (higher === null) return false;
	if (lower === null) return true;
	for (const position of [0, 1, 2] as const)
		if (higher.core[position] !== lower.core[position])
			return higher.core[position] > lower.core[position];
	return comparePrerelease(higher.prerelease, lower.prerelease) > 0;
}

/** The warning a suite's stamp earns against the installed version, or null. */
export function versionWarning(
	stamp: string | undefined,
	installed: string,
): string | null {
	if (stamp === undefined || stamp === "") return null;
	const relation = compareVersions(stamp, installed);
	if (relation === "older")
		return `warning: this suite was written by llm-tests-forge ${stamp}; installed is ${installed}`;
	if (relation === "newer")
		return `warning: this suite was written by llm-tests-forge ${stamp}, newer than the installed ${installed}; upgrade llm-tests-forge before changing it`;
	return null;
}
