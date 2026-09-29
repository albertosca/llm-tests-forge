defmodule LlmTestsForge do
  @moduledoc """
  Installs and runs the `llm-tests-forge` binary that belongs to this package's
  version.

  The binary is downloaded from the GitHub Release of that version, and its
  SHA256 is compared with `checksums.exs`, which ships inside this package (the
  release workflow writes it from the release's `SHA256SUMS`). A binary whose
  hash differs is refused and never lands on disk. See the two mix tasks:

    * `mix llm_tests_forge.install [--if-missing]`
    * `mix llm_tests_forge <arguments>`
  """

  @version Mix.Project.config()[:version]
  @repository_url "https://github.com/albertosca/llm-tests-forge"
  @default_base_url "#{@repository_url}/releases/download/v#{@version}"
  @binary_name "llm-tests-forge"

  # The asset each supported platform downloads, keyed by "<platform>-<architecture>".
  @assets %{
    "darwin-arm64" => "llm-tests-forge-darwin-arm64",
    "darwin-x64" => "llm-tests-forge-darwin-x64",
    "linux-x64" => "llm-tests-forge-linux-x64",
    "linux-arm64" => "llm-tests-forge-linux-arm64",
    "win32-x64" => "llm-tests-forge-windows-x64.exe"
  }

  @checksums_path Path.expand("../checksums.exs", __DIR__)
  @external_resource @checksums_path
  unless File.exists?(@checksums_path),
    do:
      raise(
        "checksums.exs is missing from the llm_tests_forge package; " <>
          "the release renders it with scripts/release/hex-checksums.ts"
      )

  @checksums @checksums_path |> Code.eval_file() |> elem(0)

  # Run under `sh -c`: a port's stdin is a pipe that never closes, so the binary
  # is given an empty stdin instead, and then replaces the shell so the port
  # reports the binary's own exit status.
  @empty_stdin_script ~S"""
  exec "$@" </dev/null
  """

  @doc "The version of the package, which is also the version of the binary it installs."
  def version, do: @version

  @doc """
  The message for a platform this package ships no binary for.
  """
  def unsupported_message(platform_key) do
    "#{@binary_name} has no binary for #{platform_key}; see #{@repository_url} for install.sh"
  end

  @doc """
  The platform key (`darwin-arm64`, `linux-x64`, `win32-x64`, ...) for an
  `:os.type()` tuple and a `:erlang.system_info(:system_architecture)` string.
  """
  def platform_key(os_type, system_architecture) do
    platform =
      case os_type do
        {:win32, _} -> "win32"
        {:unix, name} -> Atom.to_string(name)
      end

    architecture =
      system_architecture
      |> to_string()
      |> String.split("-")
      |> hd()
      |> case do
        name when name in ["aarch64", "arm64"] -> "arm64"
        name when name in ["x86_64", "amd64", "win32"] -> "x64"
        name -> name
      end

    "#{platform}-#{architecture}"
  end

  @doc "The release asset for a platform key, or `:error` when none is shipped."
  def asset_for(platform_key), do: Map.fetch(@assets, platform_key)

  @doc "The release asset for the machine running this VM; raises a `Mix.Error` on an unsupported platform."
  def host_asset! do
    key = platform_key(:os.type(), :erlang.system_info(:system_architecture))

    case asset_for(key) do
      {:ok, asset} -> asset
      :error -> Mix.raise(unsupported_message(key))
    end
  end

  @doc "Where the binary lives: `_build/llm-tests-forge` (`.exe` on Windows), beside the project's build directory."
  def binary_path do
    suffix = if match?({:win32, _}, :os.type()), do: ".exe", else: ""
    Path.join(Path.dirname(Mix.Project.build_path()), @binary_name <> suffix)
  end

  @doc "The base URL the assets are downloaded from: `LLM_TESTS_FORGE_BASE_URL` when set, else this version's GitHub Release."
  def base_url do
    case System.get_env("LLM_TESTS_FORGE_BASE_URL") do
      nil -> @default_base_url
      "" -> @default_base_url
      url -> String.trim_trailing(url, "/")
    end
  end

  @doc """
  Downloads the host's binary, checks its SHA256 against `checksums.exs` and
  installs it at `binary_path/0` with the exec bit. Raises a `Mix.Error`, and
  leaves nothing behind, when the download fails or the hash differs.
  `log` receives one line of progress.
  """
  def install!(log \\ &IO.puts/1) do
    asset = host_asset!()
    url = "#{base_url()}/#{asset}"
    expected = expected_checksum!(asset)
    log.("Downloading #{url}")
    body = download!(url, asset)
    actual = :crypto.hash(:sha256, body) |> Base.encode16(case: :lower)

    if actual != expected do
      Mix.raise(
        "checksum mismatch for #{asset}: expected #{expected}, got #{actual}; the download was discarded"
      )
    end

    path = binary_path()
    File.mkdir_p!(Path.dirname(path))
    partial = path <> ".download"
    File.write!(partial, body)
    File.chmod!(partial, 0o755)
    # The sidecar is removed before the binary changes and written after, so
    # an interrupted install reads as "not installed", never as a match.
    File.rm(version_path())
    File.rename!(partial, path)
    File.write!(version_path(), actual)
    log.("Installed #{path} (#{asset}, sha256 #{actual})")
    path
  end

  @doc "Where the installed binary's sidecar lives: it holds the SHA256 the binary was verified against."
  def version_path, do: binary_path() <> ".version"

  @doc """
  Whether the binary at `binary_path/0` is the one this package version ships:
  it exists and its sidecar holds the SHA256 that `checksums.exs` lists for the
  host asset. A binary left by another package version (or by no install of
  this package) is not installed.
  """
  def installed? do
    File.regular?(binary_path()) and
      File.read(version_path()) == {:ok, expected_checksum!(host_asset!())}
  end

  @doc "The installed binary's path, installing it first when it is missing or belongs to another version."
  def ensure_installed!(log \\ &IO.puts/1) do
    if installed?(), do: binary_path(), else: install!(log)
  end

  defp expected_checksum!(asset) do
    case Map.fetch(@checksums, asset) do
      {:ok, checksum} -> checksum
      :error -> Mix.raise("checksums.exs has no entry for #{asset}")
    end
  end

  defp download!(url, asset) do
    {:ok, _started} = Application.ensure_all_started(:inets)
    {:ok, _started} = Application.ensure_all_started(:ssl)

    request = {String.to_charlist(url), [{~c"user-agent", ~c"llm_tests_forge-mix"}]}

    http_options =
      [timeout: 300_000, connect_timeout: 30_000, autoredirect: true] ++ tls_options(url)

    case :httpc.request(:get, request, http_options, body_format: :binary) do
      {:ok, {{_version, 200, _reason}, _headers, body}} ->
        body

      {:ok, {{_version, status, _reason}, _headers, _body}} ->
        Mix.raise("downloading #{asset} from #{url} failed: HTTP #{status}")

      {:error, reason} ->
        Mix.raise("downloading #{asset} from #{url} failed: #{inspect(reason)}")
    end
  end

  defp tls_options("https://" <> _rest) do
    unless function_exported?(:public_key, :cacerts_get, 0) do
      Mix.raise(
        "downloading over HTTPS needs OTP 25 or newer (:public_key.cacerts_get/0 is missing); " <>
          "install the binary from #{@repository_url} instead"
      )
    end

    [
      ssl: [
        verify: :verify_peer,
        cacerts: :public_key.cacerts_get(),
        depth: 4,
        customize_hostname_check: [
          match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
        ]
      ]
    ]
  end

  defp tls_options(_url), do: []

  @doc """
  Runs `binary` with `arguments` and returns its exit status (128 plus the
  signal when a signal killed it).

  The binary's stdout is relayed and its stderr is this VM's; its stdin is
  empty. It does not get the terminal: the BEAM starts every child in a new
  session (no controlling terminal, so no `/dev/tty`, and the terminal's
  Ctrl+C is never delivered to it), while the VM itself answers Ctrl+C with
  its own break menu. The VM's break handler cannot be turned off from
  inside a running VM (`:os.set_signal/2` does not accept `:sigint`; `+Bi`
  is a start-up flag). So interactive commands, `review` above all, must run
  the installed binary directly.
  """
  def run_binary(binary, arguments) do
    {command, command_arguments} =
      case :os.type() do
        {:win32, _} ->
          {binary, arguments}

        {:unix, _} ->
          {System.find_executable("sh") || "/bin/sh",
           ["-c", @empty_stdin_script, @binary_name, binary | arguments]}
      end

    {_relayed, status} =
      System.cmd(command, command_arguments, into: IO.binstream(:stdio, :line))

    status
  end
end
