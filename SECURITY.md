# Security policy

## Supported versions

Only the latest 0.x release is supported. The project is young; fixes land on `main` and in the next release.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting: on the repository page, open **Security**, then **Report a vulnerability**. The report reaches the maintainer only, and a fix can be prepared before anything is disclosed.

Say what you ran, what you expected and what happened. A minimal reproduction helps the most.

## What counts

- The installer (`install.sh`) and the way it verifies a download: a path that installs a binary without the checks it claims to make.
- The release workflow and the packages built from it (npm, PyPI, RubyGems, Hex, Homebrew): a way to ship something that is not the audited binary.
- The generated shims and the `exec` and `http` target kinds: a way for a case file, a `forge.yaml` or a model reply to run a command or reach a host the person did not configure.
- Credentials: any path that prints an API key, writes one to a file under `.forge/`, or sends it to a host other than its provider.

## What does not count

- The quality of a model's output, or a wrong expected value in a case a person approved: that is what the review is for.
- Findings that need the attacker to already control your shell, your `forge.yaml` or your application's code.

## What to expect

The tool is maintained by one person, on a best-effort basis, so there is no promised response time. A confirmed issue is fixed in order of severity, and the reporter can be credited in the release notes if they wish.
