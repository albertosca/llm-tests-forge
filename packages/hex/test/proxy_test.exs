defmodule LlmTestsForgeProxyTest do
  # Every test uses the package's one :httpc profile, so they run one at a time.
  use ExUnit.Case, async: false

  # The proxies :httpc would use after configure_proxy!/2 read `environment`,
  # read back from the fresh profile the download uses. No proxy is contacted.
  defp httpc_proxies(environment) do
    LlmTestsForge.with_httpc_profile(fn profile ->
      LlmTestsForge.configure_proxy!(environment, profile)
      {:ok, options} = :httpc.get_options([:proxy, :https_proxy], profile)
      options
    end)
  end

  test "HTTPS_PROXY and HTTP_PROXY set :httpc's https_proxy and proxy, with NO_PROXY's hosts bypassed" do
    # A host also covers its subdomains, as in curl; a leading dot covers only those.
    bypassed = [
      ~c"localhost",
      ~c"*.localhost",
      ~c"*.internal.invalid",
      ~c"example.invalid",
      ~c"*.example.invalid"
    ]

    assert httpc_proxies(%{
             "HTTPS_PROXY" => "http://secure.proxy.invalid:3128",
             "HTTP_PROXY" => "http://plain.proxy.invalid:8080/",
             "NO_PROXY" => "localhost, .internal.invalid,example.invalid"
           }) == [
             proxy: {{~c"plain.proxy.invalid", 8080}, bypassed},
             https_proxy: {{~c"secure.proxy.invalid", 3128}, bypassed}
           ]
  end

  test "the lowercase spellings count, and win over the uppercase ones as curl's do" do
    assert httpc_proxies(%{
             "https_proxy" => "http://lower.proxy.invalid:3128",
             "HTTPS_PROXY" => "http://upper.proxy.invalid:3128",
             "http_proxy" => "plain.proxy.invalid:8080",
             "no_proxy" => "localhost"
           }) == [
             proxy: {{~c"plain.proxy.invalid", 8080}, [~c"localhost", ~c"*.localhost"]},
             https_proxy: {{~c"lower.proxy.invalid", 3128}, [~c"localhost", ~c"*.localhost"]}
           ]
  end

  test "a proxy URL without a port takes its scheme's default" do
    assert httpc_proxies(%{"HTTPS_PROXY" => "http://proxy.invalid"})[:https_proxy] ==
             {{~c"proxy.invalid", 80}, []}
  end

  test "no proxy variable, an empty one, or NO_PROXY=* leaves :httpc connecting directly" do
    for environment <- [
          %{},
          %{"HTTPS_PROXY" => "", "HTTP_PROXY" => ""},
          %{"HTTPS_PROXY" => "http://proxy.invalid:3128", "NO_PROXY" => "*"}
        ] do
      assert httpc_proxies(environment) == [
               proxy: {:undefined, []},
               https_proxy: {:undefined, []}
             ]
    end
  end

  test "the profile is fresh for each download: a proxy set for one is gone in the next" do
    assert httpc_proxies(%{"HTTPS_PROXY" => "http://stale.proxy.invalid:1"})[:https_proxy] ==
             {{~c"stale.proxy.invalid", 1}, []}

    assert httpc_proxies(%{})[:https_proxy] == {:undefined, []}
  end

  test "a proxy variable that names no host is refused, naming the variable" do
    assert_raise Mix.Error, "HTTPS_PROXY is not a proxy URL: http://:3128", fn ->
      httpc_proxies(%{"HTTPS_PROXY" => "http://:3128"})
    end
  end
end
