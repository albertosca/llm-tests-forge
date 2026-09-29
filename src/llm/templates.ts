import casesTemplate from "../../templates/cases.md" with { type: "text" };
import dedupeTemplate from "../../templates/dedupe.md" with { type: "text" };
import describeTemplate from "../../templates/describe.md" with {
	type: "text",
};
import guideTemplate from "../../templates/guide.md" with { type: "text" };
import scenariosTemplate from "../../templates/scenarios.md" with {
	type: "text",
};
import elixirShim from "../../templates/shims/elixir.exs.tmpl" with {
	type: "text",
};
import goMainShim from "../../templates/shims/go.main.go.tmpl" with {
	type: "text",
};
import goModShim from "../../templates/shims/go.mod.tmpl" with { type: "text" };
import javascriptShim from "../../templates/shims/javascript.mjs.tmpl" with {
	type: "text",
};
import pythonShim from "../../templates/shims/python.py.tmpl" with {
	type: "text",
};
import rubyShim from "../../templates/shims/ruby.rb.tmpl" with { type: "text" };
import rustCargoShim from "../../templates/shims/rust.Cargo.toml.tmpl" with {
	type: "text",
};
import rustMainShim from "../../templates/shims/rust.main.rs.tmpl" with {
	type: "text",
};
import typescriptShim from "../../templates/shims/typescript.ts.tmpl" with {
	type: "text",
};
import { ForgeError } from "../core/errors";

/**
 * Every template the forge renders, embedded at build time: a path read
 * from the disk at run time would point inside the build machine's
 * checkout, which a compiled binary does not carry.
 */
const TEMPLATES: Record<string, string> = {
	cases: casesTemplate,
	dedupe: dedupeTemplate,
	describe: describeTemplate,
	guide: guideTemplate,
	scenarios: scenariosTemplate,
	"shims/python": pythonShim,
	"shims/javascript": javascriptShim,
	"shims/typescript": typescriptShim,
	"shims/elixir": elixirShim,
	"shims/ruby": rubyShim,
	"shims/rust.Cargo.toml": rustCargoShim,
	"shims/rust.main.rs": rustMainShim,
	"shims/go.mod": goModShim,
	"shims/go.main.go": goMainShim,
};

export function loadTemplate(name: string): string {
	const template = TEMPLATES[name];
	if (template === undefined)
		throw new ForgeError("template not found", { id: name });
	return template;
}

export function render(
	template: string,
	variables: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const value = variables[key];
		if (value === undefined)
			throw new ForgeError(`template placeholder "{{${key}}}" has no value`);
		return value;
	});
}
