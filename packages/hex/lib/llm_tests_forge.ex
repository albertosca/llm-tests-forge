defmodule LlmTestsForge do
  @moduledoc """
  Installs and runs the `llm-tests-forge` binary that belongs to this package's
  version.

  The binary is downloaded from the GitHub Release of that version, and its
  SHA256 is compared with `checksums.exs`, which ships inside this package (the
  release workflow writes it from the release's `SHA256SUMS`). A binary whose
  hash differs is refused and never lands on disk.

  Add it as a development-only dependency that is never started at runtime:

      {:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}

  Then use the two mix tasks:

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
  Windows reports `win32` whatever the processor, so Windows on ARM maps to
  `win32-x64`, whose binary runs there under emulation.
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

  @doc """
  The proxy a GET of `url` goes through, read from `environment` as curl
  reads it, or `nil` for a direct connection. `:httpc` reads none of these
  variables itself.

    * The URL's scheme picks the variable: an `https` URL uses only
      `https_proxy`/`HTTPS_PROXY`, an `http` URL only `http_proxy`/`HTTP_PROXY`
      (the lowercase spelling wins; an empty value is unset).
    * The value is trimmed; a missing scheme means `http://`, a missing port
      1080 (curl's default). `user:password@` becomes `:httpc`'s
      `proxy_auth`. Only `http://` proxies work: `:httpc` reaches a proxy over
      plain HTTP, so `socks4/5://` and `https://` are refused by name.
    * `no_proxy`/`NO_PROXY` is a comma-separated list of hosts reached
      directly, compared case-insensitively: `example.com` and `.example.com`
      both cover `example.com` and every host under it, `host:port` covers
      that port only, and `*` covers everything. CIDR ranges are not
      supported: `10.0.0.0/8` matches no host. A redirect (GitHub sends the
      download to `release-assets.githubusercontent.com`) is judged by
      `:httpc` against `httpc_no_proxy/2`, which honours host and domain
      entries but not `host:port` ones, and compares case-sensitively; a
      redirect to another scheme keeps the first URL's proxy choice.

  Returns `%{option: :proxy | :https_proxy, address: {host, port}, auth:
  {user, password} | nil}`. Raises a `Mix.Error` naming the variable when its
  value is not a usable proxy URL; the message never shows credentials.
  """
  def proxy_for!(url, environment) do
    if bypassed?(URI.parse(url), no_proxy_entries(environment)),
      do: nil,
      else: configured_proxy!(url, environment)
  end

  # The proxy the variable for `url`'s scheme names, NO_PROXY aside.
  defp configured_proxy!(url, environment) do
    {variable, option} =
      if URI.parse(url).scheme == "https",
        do: {"https_proxy", :https_proxy},
        else: {"http_proxy", :proxy}

    case proxy_variable(environment, variable) do
      nil ->
        nil

      {name, value} ->
        {address, auth} = parse_proxy!(name, value)
        %{option: option, address: address, auth: auth}
    end
  end

  @doc """
  NO_PROXY in the form `:httpc` matches against every host a download
  reaches, redirects included, or `:all` for `*`.

  `:httpc` compares a host name entry exactly, and an entry `"*." <> rest`
  by `lists:suffix(rest, host)` (`httpc_handler:is_no_proxy_dest/2`), without
  the dot and case-sensitively. So `example.com` and `.example.com` both
  become `example.com` and `*..example.com`: the host itself, and the hosts
  that end in `.example.com`, never `notexample.com`. A `host:port` entry
  cannot be expressed and is left out, and entries are lowercased, so on a
  redirect (to `release-assets.githubusercontent.com`, for a GitHub Release)
  those two are not honoured; the first URL is always judged by
  `proxy_for!/2`, whose own host is listed when NO_PROXY bypasses it.
  """
  def httpc_no_proxy(url, environment) do
    target = URI.parse(url)

    case no_proxy_entries(environment) do
      :all ->
        :all

      entries ->
        first = if bypassed?(target, entries), do: [String.to_charlist(target.host)], else: []

        first ++
          for {domain, nil} <- entries,
              form <- [domain, "*.." <> domain],
              do: String.to_charlist(form)
    end
  end

  # The variable's name and trimmed value, lowercase spelling first; an empty
  # value is unset.
  defp proxy_variable(environment, lowercase) do
    [lowercase, String.upcase(lowercase)]
    |> Enum.map(&{&1, String.trim(Map.get(environment, &1) || "")})
    |> Enum.find(fn {_name, value} -> value != "" end)
  end

  # NO_PROXY's entries as `{domain, port | nil}`, lowercased, without a
  # leading dot or IPv6 brackets; `:all` when one is `*`.
  defp no_proxy_entries(environment) do
    entries =
      case proxy_variable(environment, "no_proxy") do
        nil ->
          []

        {_name, value} ->
          value |> String.split(",") |> Enum.map(&(&1 |> String.trim() |> String.downcase()))
      end
      |> Enum.reject(&(&1 == ""))

    if "*" in entries, do: :all, else: Enum.map(entries, &no_proxy_entry/1)
  end

  defp no_proxy_entry(entry) do
    {entry_host, entry_port} =
      case Regex.run(~r/\A(.*?):(\d+)\z/, entry) do
        [_entry, entry_host, entry_port] -> {entry_host, String.to_integer(entry_port)}
        nil -> {entry, nil}
      end

    domain =
      entry_host
      |> String.trim_leading(".")
      |> String.trim_leading("[")
      |> String.trim_trailing("]")

    {domain, entry_port}
  end

  defp bypassed?(_target, :all), do: true

  defp bypassed?(%URI{host: host, port: port}, entries) do
    host = String.downcase(host || "")

    Enum.any?(entries, fn {domain, entry_port} ->
      (entry_port == nil or entry_port == port) and
        (host == domain or String.ends_with?(host, "." <> domain))
    end)
  end

  defp parse_proxy!(name, value) do
    {scheme, rest} = split_scheme(value)
    # Everything up to the last `@` is the userinfo, so a password may hold
    # an unencoded `/`, `?`, `#` or `@`; it never reaches a message.
    {userinfo, after_userinfo} = split_userinfo(rest)
    shown = if userinfo, do: "#{scheme}://***@#{after_userinfo}", else: "#{scheme}://#{rest}"

    unless String.downcase(scheme) == "http" do
      Mix.raise(
        "#{name} uses #{scheme}://, which this installer cannot use " <>
          "(:httpc reaches a proxy over plain HTTP only); set an http:// proxy, or install with install.sh"
      )
    end

    host_and_port = after_userinfo |> String.split(["/", "?", "#"], parts: 2) |> hd()
    {host, port_text} = split_host_and_port(host_and_port)

    if host == "", do: Mix.raise("#{name} is not a proxy URL: #{shown}")

    port =
      case port_text do
        "" ->
          1080

        text ->
          valid_port(text) ||
            Mix.raise("#{name} has a port that is not a number from 1 to 65535: #{shown}")
      end

    {{String.to_charlist(host), port}, proxy_auth(userinfo)}
  end

  # The scheme and the rest; a value without a well-formed `scheme://` (a
  # `://` inside a password does not count) is http.
  defp split_scheme(value) do
    case Regex.run(~r{\A([A-Za-z][A-Za-z0-9+.-]*)://(.*)\z}s, value) do
      [_value, scheme, rest] -> {scheme, rest}
      nil -> {"http", value}
    end
  end

  # The userinfo (everything before the last `@`, or nil) and what follows it.
  defp split_userinfo(rest) do
    case String.split(rest, "@") do
      [no_userinfo] ->
        {nil, no_userinfo}

      parts ->
        {after_userinfo, userinfo_parts} = List.pop_at(parts, -1)
        {Enum.join(userinfo_parts, "@"), after_userinfo}
    end
  end

  defp split_host_and_port("[" <> bracketed) do
    case String.split(bracketed, "]", parts: 2) do
      [host, ":" <> port] -> {host, port}
      [host, ""] -> {host, ""}
      _malformed -> {"", ""}
    end
  end

  defp split_host_and_port(host_and_port) do
    case String.split(host_and_port, ":", parts: 2) do
      [host, port] -> {host, port}
      [host] -> {host, ""}
    end
  end

  defp valid_port(text) do
    case Integer.parse(text) do
      {port, ""} when port in 1..65_535 -> port
      _invalid -> nil
    end
  end

  defp proxy_auth(nil), do: nil

  defp proxy_auth(userinfo) do
    {user, password} =
      case String.split(userinfo, ":", parts: 2) do
        [user, password] -> {user, password}
        [user] -> {user, ""}
      end

    {String.to_charlist(URI.decode(user)), String.to_charlist(URI.decode(password))}
  end

  @doc """
  GETs `url` through the proxy `environment` names for it (see
  `proxy_for!/2`), in a fresh `:httpc` profile, and returns `:httpc`'s own
  result.
  """
  def http_get(url, environment) do
    {:ok, _started} = Application.ensure_all_started(:inets)
    {:ok, _started} = Application.ensure_all_started(:ssl)

    request = {String.to_charlist(url), [{~c"user-agent", ~c"llm_tests_forge-mix"}]}
    no_proxy = httpc_no_proxy(url, environment)
    # The first URL is judged by proxy_for!/2; the proxy is set whenever its
    # variable is (unless NO_PROXY is `*`), with NO_PROXY as :httpc matches
    # it, so a redirect to another host is judged again.
    proxy = if no_proxy != :all, do: configured_proxy!(url, environment)

    http_options =
      [timeout: 300_000, connect_timeout: 30_000, autoredirect: true] ++
        tls_options(url) ++ proxy_auth_option(proxy)

    with_httpc_profile(fn profile ->
      # Only the option for this URL's scheme: with `https_proxy` unset,
      # :httpc would send an https request through `proxy`.
      if proxy,
        do: :ok = :httpc.set_options([{proxy.option, {proxy.address, no_proxy}}], profile)

      :httpc.request(:get, request, http_options, [body_format: :binary], profile)
    end)
  end

  defp proxy_auth_option(%{auth: {user, password}}), do: [proxy_auth: {user, password}]
  defp proxy_auth_option(_no_credentials), do: []

  defp download!(url, asset) do
    case http_get(url, System.get_env()) do
      {:ok, {{_version, 200, _reason}, _headers, body}} ->
        body

      {:ok, {{_version, status, _reason}, _headers, _body}} ->
        Mix.raise("downloading #{asset} from #{url} failed: HTTP #{status}")

      {:error, reason} ->
        Mix.raise("downloading #{asset} from #{url} failed: #{inspect(reason)}")
    end
  end

  @doc """
  Runs `function` with a fresh `:httpc` profile of this package's, stopped
  afterwards, so no option set for one download outlives it.
  """
  def with_httpc_profile(function) do
    {:ok, _started} = Application.ensure_all_started(:inets)
    profile = :llm_tests_forge
    _stopped = :inets.stop(:httpc, profile)
    {:ok, _pid} = :inets.start(:httpc, profile: profile)

    try do
      function.(profile)
    after
      :inets.stop(:httpc, profile)
    end
  end

  defp tls_options("https://" <> _rest) do
    # function_exported?/3 does not load the module, and a fresh VM has not
    # loaded :public_key yet.
    unless Code.ensure_loaded?(:public_key) and
             function_exported?(:public_key, :cacerts_get, 0) do
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
