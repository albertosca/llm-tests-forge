defmodule Mix.Tasks.LlmTestsForge.Install do
  @shortdoc "Downloads the llm-tests-forge binary from its GitHub Release and verifies its SHA256"

  @moduledoc """
  Downloads the `llm-tests-forge` binary for this machine from the GitHub
  Release of the package's version, checks its SHA256 against the
  `checksums.exs` the package ships, and installs it at
  `_build/llm-tests-forge` with the exec bit.

      mix llm_tests_forge.install [--if-missing]

  A hash that differs makes the task raise, naming the asset, and nothing is
  installed. `--if-missing` does nothing when the binary is already there.

  The base URL defaults to the version's GitHub Release and can be overridden
  with the `LLM_TESTS_FORGE_BASE_URL` environment variable (a mirror, or a
  local server in tests); the checksum comparison applies either way.

  Behind a proxy, an HTTPS download goes through `https_proxy`/`HTTPS_PROXY`
  and an HTTP one through `http_proxy`/`HTTP_PROXY`, minus the hosts in
  `no_proxy`/`NO_PROXY`, as curl reads them (`:httpc` reads none of them on
  its own); see `LlmTestsForge.proxy_for!/2`. Only `http://` proxies work.
  GitHub redirects the download to `release-assets.githubusercontent.com`;
  NO_PROXY's host and domain entries apply there too, its `host:port`
  entries do not.

  Windows on ARM gets the x64 binary, which runs there under emulation.
  """

  use Mix.Task

  @impl Mix.Task
  def run(arguments) do
    {switches, _positional} = OptionParser.parse!(arguments, strict: [if_missing: :boolean])

    if switches[:if_missing] && LlmTestsForge.installed?() do
      Mix.shell().info("#{LlmTestsForge.binary_path()} is already installed")
    else
      path = LlmTestsForge.install!(fn line -> Mix.shell().info(line) end)

      Mix.shell().info(
        "Run it with `mix llm_tests_forge <arguments>` or directly: #{path} <arguments>"
      )
    end
  end
end
