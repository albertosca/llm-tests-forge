import { parse } from "yaml";
import { ZodError, type ZodType } from "zod";
import { DescribeOutputSchema } from "../../src/core/describe";
import { ForgeError } from "../../src/core/errors";
import { type Feature, ScenarioSchema } from "../../src/core/schemas";
import type { ExecInvocation } from "./exec-arguments";

/** The text of an input the suite must supply, or a refusal naming it. */
export function requiredVariable(
	invocation: ExecInvocation,
	name: string,
	targetName: string,
): string {
	const value = invocation.variables[name];
	if (value === undefined)
		throw new ForgeError(
			`the ${targetName} target needs the \`${name}\` input`,
		);
	return value;
}

function parsedAs<T>(text: string, schema: ZodType<T>, name: string): T {
	try {
		return schema.parse(parse(text));
	} catch (error) {
		const reasons =
			error instanceof ZodError
				? error.issues
						.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
						.join("; ")
				: "it is not YAML";
		throw new ForgeError(
			`the ${name} input is not a valid ${name}: ${reasons}`,
		);
	}
}

/** A feature as `describe` writes it, taken as approved: the real functions only ask for that. */
export function featureFrom(text: string): Feature {
	return {
		...parsedAs(text, DescribeOutputSchema, "feature"),
		status: "approved",
	};
}

/** A scenario as `scenarios` writes it, taken as approved. */
export function scenarioFrom(text: string) {
	return {
		...parsedAs(text, ScenarioSchema.omit({ status: true }), "scenario"),
		status: "approved" as const,
	};
}
