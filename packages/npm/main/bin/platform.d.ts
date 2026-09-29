export function platformPackage(
	platform: string,
	architecture: string,
): { packageName: string; binaryPath: string } | undefined;
export function unsupportedMessage(
	platform: string,
	architecture: string,
): string;
