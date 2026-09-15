export interface ForgeErrorDetails {
	file?: string;
	id?: string;
	rawPath?: string;
}

export class ForgeError extends Error {
	readonly details: ForgeErrorDetails;

	constructor(message: string, details: ForgeErrorDetails = {}) {
		const parts: string[] = [];
		if (details.file) parts.push(`file: ${details.file}`);
		if (details.id) parts.push(`id: ${details.id}`);
		if (details.rawPath) parts.push(`raw: ${details.rawPath}`);
		super(parts.length > 0 ? `${message} (${parts.join(", ")})` : message);
		this.name = "ForgeError";
		this.details = details;
	}
}
