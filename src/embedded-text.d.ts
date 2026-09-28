/** Files embedded as text at build time through `with { type: "text" }`. */
declare module "*.md" {
	const text: string;
	export default text;
}
declare module "*.tmpl" {
	const text: string;
	export default text;
}
