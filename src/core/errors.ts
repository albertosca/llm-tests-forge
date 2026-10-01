/**
 * What a failure says: its message, or the thrown value itself when it
 * carries none. Total: a value with no prototype (`Object.create(null)`),
 * a `toString` that throws or a `message` getter that throws reads as a
 * fixed sentence, so reporting a failure never fails itself.
 */
export function messageOf(error: unknown): string {
	try {
		return typeof error === "object" && error !== null && "message" in error
			? String(error.message)
			: String(error);
	} catch {
		return "a value that cannot be shown as text";
	}
}

export interface ForgeErrorDetails {
	file?: string;
	id?: string;
	rawPath?: string;
}

export class ForgeError extends Error {
	readonly details: ForgeErrorDetails;
	/** The message without the details suffix, for a caller that names the file itself. */
	readonly reason: string;

	constructor(message: string, details: ForgeErrorDetails = {}) {
		const parts: string[] = [];
		if (details.file !== undefined) parts.push(`file: ${details.file}`);
		if (details.id !== undefined) parts.push(`id: ${details.id}`);
		if (details.rawPath !== undefined) parts.push(`raw: ${details.rawPath}`);
		super(parts.length > 0 ? `${message} (${parts.join(", ")})` : message);
		this.name = "ForgeError";
		this.details = details;
		this.reason = message;
	}
}

/**
 * A ForgeError that additionally marks the failure as a CLI usage mistake
 * rather than a runtime failure — the CLI's `run()` maps this to exit code
 * 2 instead of 1. Every bad flag value and every missing required argument
 * is one of these, wherever it is raised: an unusable command line is the
 * same failure whether the parser, a flag validator or the model resolver
 * notices it, and it exits 2 in all three cases. A failure that only shows
 * up while doing the work — a file that is not there, a model that refuses,
 * a feature that is still pending — is a plain ForgeError and exits 1. Kept as its own class,
 * not a `ForgeErrorDetails` field, so this routing marker never leaks into
 * the printed message the way overloading `details.file` with a
 * non-file value once did.
 *
 * The constructor below is written out (rather than left as an empty
 * `class UsageError extends ForgeError {}` body, which would do the exact
 * same thing) because bun's coverage instrumentation mis-attributes an
 * empty-body subclass's implicit constructor to its base class's
 * declaration line, reporting it as an uncovered function even once
 * constructed — confirmed with a throwaway repro outside this repo.
 */
export class UsageError extends ForgeError {
	constructor(message: string, details: ForgeErrorDetails = {}) {
		super(message, details);
		this.name = "UsageError";
	}
}
