// The hook is plain JavaScript because Node loads it before anything could
// compile it; these are its types for the test that calls it.
export interface ResolveContext {
	parentURL?: string | undefined;
}

export function resolveForStryker<Resolved>(
	specifier: string,
	context: ResolveContext,
	nextResolve: (specifier: string, context: ResolveContext) => Resolved,
): Resolved;
