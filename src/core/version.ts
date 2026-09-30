import packageJson from "../../package.json" with { type: "json" };

/** The installed forge's version, embedded at build time from package.json. */
export const FORGE_VERSION: string = packageJson.version;

export type VersionRelation = "same" | "patch" | "older" | "newer";

interface ParsedVersion {
	/** Major, minor and patch as digit strings: `Number` loses precision past 2^53. */
	core: [string, string, string];
	/** The dot-separated identifiers after `-`; empty for a release. */
	prerelease: string[];
}

/** A numeric identifier: zero, or digits with no leading zero. */
const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
/** A prerelease identifier: numeric, or alphanumerics and hyphens with at least one non-digit. */
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
/** A build identifier: any non-empty run of alphanumerics and hyphens, leading zeros included. */
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
/** The SemVer 2.0.0 grammar, with the core and the prerelease captured. */
const SEMVER = new RegExp(
	`^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
		`(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
		`(?:\\+${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*)?$`,
);

/**
 * A SemVer 2.0.0 version, or null when it is outside that grammar (a leading
 * zero, an empty or invalid identifier). Build metadata is parsed and
 * dropped: it never takes part in precedence.
 */
function parseVersion(version: string): ParsedVersion | null {
	const match = SEMVER.exec(version);
	if (!match) return null;
	return {
		// Stryker disable next-line StringLiteral: the three core groups take part in every match, so no default is ever read
		core: [match[1] ?? "", match[2] ?? "", match[3] ?? ""],
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

/**
 * Two numeric identifiers compared exactly, at any size: with no leading
 * zeros (the grammar forbids them) the longer is larger, and equal lengths
 * compare as text. Negative, zero or positive, as `left` is lower, equal or
 * higher.
 */
function compareDigits(left: string, right: string): number {
	if (left.length !== right.length) return left.length - right.length;
	return compareText(left, right);
}

/** 1, 0 or -1 as `left` sorts after, with or before `right` in ASCII order. */
function compareText(left: string, right: string): number {
	return Number(left > right) - Number(left < right);
}

/**
 * Two prerelease identifiers: numeric ones compare as numbers and sit below
 * alphanumeric ones, which compare in ASCII order. Negative, zero or
 * positive, as `left` is lower, equal or higher.
 */
function compareIdentifiers(left: string, right: string): number {
	const leftNumeric = /^\d+$/.test(left);
	const rightNumeric = /^\d+$/.test(right);
	if (leftNumeric && rightNumeric) return compareDigits(left, right);
	if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
	return compareText(left, right);
}

/**
 * Semver precedence of two prereleases: a release (no identifiers) is above
 * any prerelease of it, identifiers compare one by one, and a longer list
 * wins when the shared part is equal. Negative when `left` is lower,
 * positive when higher, 0 when equal.
 */
function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0)
		return right.length - left.length;
	const shared = Math.min(left.length, right.length);
	for (let position = 0; position < shared; position++) {
		const difference = compareIdentifiers(
			// Stryker disable next-line StringLiteral: position stays below both lengths, so neither default is ever read
			left[position] ?? "",
			// Stryker disable next-line StringLiteral: position stays below both lengths, so neither default is ever read
			right[position] ?? "",
		);
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

/** The full SemVer precedence of two parsed versions, core then prerelease. */
function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
	for (const position of [0, 1, 2] as const) {
		const difference = compareDigits(left.core[position], right.core[position]);
		if (difference !== 0) return difference;
	}
	return comparePrerelease(left.prerelease, right.prerelease);
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
		const difference = compareDigits(
			stamped.core[position],
			current.core[position],
		);
		if (difference < 0) return "older";
		if (difference > 0) return "newer";
	}
	if (stamped.core[2] !== current.core[2]) return "patch";
	// Same major.minor.patch: only the prerelease can differ, and that is never
	// more than a patch-level difference, so it never warns (the spec warns on
	// major or minor alone). The never-lowered rule is `isHigherVersion`'s.
	const difference = comparePrerelease(stamped.prerelease, current.prerelease);
	return difference === 0 ? "same" : "patch";
}

/**
 * True when `candidate` is a higher version than `existing` (patch and
 * prerelease included, unlike `compareVersions`; a release is above its
 * prereleases). Anything that is not that shape counts as lowest, so a
 * garbled stamp is always replaceable.
 */
export function isHigherVersion(candidate: string, existing: string): boolean {
	const higher = parseVersion(candidate);
	const lower = parseVersion(existing);
	if (higher === null) return false;
	if (lower === null) return true;
	return compareParsed(higher, lower) > 0;
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
