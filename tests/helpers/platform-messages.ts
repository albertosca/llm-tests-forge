/**
 * What every package (npm's launcher, the wheels, the gems) and install.sh
 * print on musl Linux, which no release binary runs on: the linux-<cpu>
 * binary needs glibc, so naming linux-x64 as unsupported, or pointing at
 * install.sh, would be false. `name` is the npm name (linux-x64).
 */
export function muslMessage(name: string): string {
	return `llm-tests-forge has no binary for musl/Alpine yet (${name}-musl): the ${name} binary needs glibc; see https://github.com/albertosca/llm-tests-forge`;
}
