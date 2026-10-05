export function platformPackage(
	platform: string,
	architecture: string,
): { packageName: string; binaryPath: string } | undefined;
export function libcFamily(
	platform: string,
	reportHeader: { glibcVersionRuntime?: string } | undefined,
): "glibc" | "musl" | "unknown" | undefined;
export function unsupportedMessage(
	platform: string,
	architecture: string,
	libc?: string,
): string;
