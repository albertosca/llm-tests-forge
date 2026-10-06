// scopes.mjs is plain JavaScript because the Stryker config and the runner
// scripts load it under node; these are its types for the tests that read it.
export interface Scope {
	mutate: string[];
	testDirectories: string[];
	extraTests: string[];
	testsFromImporters: boolean;
	breakThreshold: number | null;
}

export const SCOPES: Record<string, Scope>;
export const DEFAULT_SCOPE: string;
export const SCOPE_NAMES: string[];

export function testFilesOf(scopeName: string): string[];

export function scopeFromEnvironment(environment: {
	STRYKER_SCOPE?: string | undefined;
}): string;

export function mutationEnvironment(
	scopeName: string,
	environment: Record<string, string | undefined>,
): Record<string, string | undefined>;
