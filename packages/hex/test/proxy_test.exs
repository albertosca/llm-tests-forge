defmodule LlmTestsForgeProxyTest do
  # The behavioural tests share the package's one :httpc profile, so the
  # module runs alone.
  use ExUnit.Case, async: false

  # A local TCP listener standing in for a target or a proxy: it sends the
  # test the first bytes the connection writes, then answers `reply` (or
  # nothing) and closes.
  defp listener(reply \\ nil) do
    {:ok, socket} =
      :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])

    {:ok, port} = :inet.port(socket)
    test_process = self()

    spawn_link(fn ->
      {:ok, connection} = :gen_tcp.accept(socket)
      {:ok, received} = :gen_tcp.recv(connection, 0, 10_000)
      send(test_process, {:received, port, received})
      if reply, do: :gen_tcp.send(connection, reply)
      :gen_tcp.close(connection)
    end)

    port
  end

  # A port nothing listens on: a request sent through it fails to connect.
  defp dead_port do
    {:ok, socket} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  defp received(port) do
    receive do
      {:received, ^port, bytes} -> bytes
    after
      10_000 -> flunk("nothing connected to port #{port}")
    end
  end

  @ok "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"

  describe "which proxy a download uses, by its scheme (behaviour, through :httpc)" do
    test "an https URL with only HTTP_PROXY set goes straight to the target" do
      target = listener()
      proxy = dead_port()

      LlmTestsForge.http_get("https://127.0.0.1:#{target}/x", %{
        "HTTP_PROXY" => "http://127.0.0.1:#{proxy}"
      })

      # A TLS handshake record, sent to the target itself.
      assert <<0x16, _rest::binary>> = received(target)
    end

    test "an http URL with only HTTPS_PROXY set goes straight to the target" do
      target = listener(@ok)
      proxy = dead_port()

      assert {:ok, {{_version, 200, _reason}, _headers, "ok"}} =
               LlmTestsForge.http_get("http://127.0.0.1:#{target}/x", %{
                 "HTTPS_PROXY" => "http://127.0.0.1:#{proxy}"
               })

      assert received(target) =~ ~r{\AGET /x HTTP/1.1\r\n}
    end

    test "an https URL goes through HTTPS_PROXY as a CONNECT tunnel, with the credentials the URL carries" do
      proxy = listener()

      LlmTestsForge.http_get("https://release.invalid:8443/x", %{
        "HTTPS_PROXY" => " http://user:pa%40ss@127.0.0.1:#{proxy} ",
        "HTTP_PROXY" => "http://127.0.0.1:#{dead_port()}"
      })

      request = received(proxy)
      assert request =~ ~r{\ACONNECT release.invalid:8443 HTTP/1.1\r\n}
      assert request =~ "proxy-authorization: Basic #{Base.encode64("user:pa@ss")}\r\n"
    end

    test "an http URL goes through HTTP_PROXY, with the credentials the URL carries" do
      proxy = listener(@ok)

      assert {:ok, {{_version, 200, _reason}, _headers, "ok"}} =
               LlmTestsForge.http_get("http://release.invalid/x", %{
                 "http_proxy" => "http://user:secret@127.0.0.1:#{proxy}",
                 "HTTPS_PROXY" => "http://127.0.0.1:#{dead_port()}"
               })

      request = received(proxy)
      assert request =~ ~r{\AGET http://release.invalid/x HTTP/1.1\r\n}
      assert request =~ "proxy-authorization: Basic #{Base.encode64("user:secret")}\r\n"
    end

    test "a host NO_PROXY names goes straight to the target even with a proxy set" do
      target = listener(@ok)

      assert {:ok, {{_version, 200, _reason}, _headers, "ok"}} =
               LlmTestsForge.http_get("http://127.0.0.1:#{target}/x", %{
                 "HTTP_PROXY" => "http://127.0.0.1:#{dead_port()}",
                 "NO_PROXY" => "example.invalid, 127.0.0.1"
               })

      assert received(target) =~ ~r{\AGET /x HTTP/1.1\r\n}
    end
  end

  test "an https download starts in a fresh VM, where :public_key is not loaded yet" do
    # function_exported?/3 does not load a module: in a VM that has not used
    # :public_key yet, the OTP check must still see cacerts_get/0.
    ebin = Path.dirname(:code.which(LlmTestsForge))
    url = "https://127.0.0.1:#{dead_port()}/x"

    {output, status} =
      System.cmd(
        "elixir",
        ["-pa", ebin, "-e", "IO.inspect(LlmTestsForge.http_get(#{inspect(url)}, %{}))"],
        stderr_to_stdout: true
      )

    refute output =~ "OTP 25"
    assert output =~ "failed_connect"
    assert status == 0
  end

  describe "proxy_for!/2" do
    test "the scheme picks the variable, the lowercase spelling wins, and an empty value is unset" do
      environment = %{
        "https_proxy" => "http://lower.invalid:3128",
        "HTTPS_PROXY" => "http://upper.invalid:3128",
        "HTTP_PROXY" => "http://plain.invalid:8080"
      }

      assert LlmTestsForge.proxy_for!("https://h.invalid/x", environment) ==
               %{option: :https_proxy, address: {~c"lower.invalid", 3128}, auth: nil}

      assert LlmTestsForge.proxy_for!("http://h.invalid/x", environment) ==
               %{option: :proxy, address: {~c"plain.invalid", 8080}, auth: nil}

      assert LlmTestsForge.proxy_for!("https://h.invalid/x", %{"HTTPS_PROXY" => ""}) == nil
      assert LlmTestsForge.proxy_for!("https://h.invalid/x", %{}) == nil
    end

    test "surrounding whitespace is trimmed, a missing scheme is http, and a missing port is 1080 as in curl" do
      assert LlmTestsForge.proxy_for!("https://h.invalid/x", %{
               "HTTPS_PROXY" => "  proxy.invalid \n"
             }) ==
               %{option: :https_proxy, address: {~c"proxy.invalid", 1080}, auth: nil}

      assert LlmTestsForge.proxy_for!("https://h.invalid/x", %{
               "HTTPS_PROXY" => "http://[::1]:3128/"
             }) == %{option: :https_proxy, address: {~c"::1", 3128}, auth: nil}
    end

    test "credentials are percent-decoded into proxy_auth" do
      assert LlmTestsForge.proxy_for!("https://h.invalid/x", %{
               "HTTPS_PROXY" => "http://us%20er:p%3Ass@proxy.invalid:3128"
             }) ==
               %{
                 option: :https_proxy,
                 address: {~c"proxy.invalid", 3128},
                 auth: {~c"us er", ~c"p:ss"}
               }
    end

    test "a port that is not a number from 1 to 65535 is refused naming the variable, never the credentials" do
      for {value, shown} <- [
            {"http://user:secret@proxy.invalid:abc", "http://***@proxy.invalid:abc"},
            {"http://proxy.invalid:70000", "http://proxy.invalid:70000"},
            {"http://proxy.invalid:0", "http://proxy.invalid:0"}
          ] do
        error =
          assert_raise Mix.Error, fn ->
            LlmTestsForge.proxy_for!("https://h.invalid/x", %{"HTTPS_PROXY" => value})
          end

        assert error.message ==
                 "HTTPS_PROXY has a port that is not a number from 1 to 65535: #{shown}"

        refute error.message =~ "secret"
      end
    end

    test "a SOCKS or HTTPS proxy is refused naming its scheme: :httpc speaks only plain HTTP to a proxy" do
      for scheme <- ["socks4", "socks5", "socks5h", "https"] do
        error =
          assert_raise Mix.Error, fn ->
            LlmTestsForge.proxy_for!("http://h.invalid/x", %{
              "http_proxy" => "#{scheme}://u:secret@proxy.invalid:1080"
            })
          end

        assert error.message ==
                 "http_proxy uses #{scheme}://, which this installer cannot use (:httpc reaches a proxy over plain HTTP only); set an http:// proxy, or install with install.sh"
      end
    end

    test "a value that names no host is refused naming the variable, never the credentials" do
      assert_raise Mix.Error, "HTTPS_PROXY is not a proxy URL: http://***@:3128", fn ->
        LlmTestsForge.proxy_for!("https://h.invalid/x", %{
          "HTTPS_PROXY" => "http://u:secret@:3128"
        })
      end
    end
  end

  describe "NO_PROXY, as curl matches it" do
    defp bypassed?(url, no_proxy) do
      LlmTestsForge.proxy_for!(url, %{
        "HTTPS_PROXY" => "http://proxy.invalid:3128",
        "HTTP_PROXY" => "http://proxy.invalid:3128",
        "NO_PROXY" => no_proxy
      }) == nil
    end

    test "a host, case-insensitively, and the domains under it, with or without a leading dot" do
      assert bypassed?("https://Example.COM/x", "example.com")
      assert bypassed?("https://x.example.com/x", "example.com")
      assert bypassed?("https://x.example.com/x", ".EXAMPLE.com")
      assert bypassed?("https://example.com/x", ".example.com")
      refute bypassed?("https://notexample.com/x", "example.com")
      refute bypassed?("https://example.com.evil/x", "example.com")
    end

    test "a host:port entry only for that port, the URL's default port included" do
      assert bypassed?("https://mirror.invalid:8443/x", "mirror.invalid:8443")
      refute bypassed?("https://mirror.invalid/x", "mirror.invalid:8443")
      assert bypassed?("https://mirror.invalid/x", "mirror.invalid:443")
      assert bypassed?("http://mirror.invalid/x", "mirror.invalid:80")
    end

    test "* bypasses every host, entries are trimmed, and a CIDR range is not supported (it matches nothing)" do
      assert bypassed?("https://anything.invalid/x", " other.invalid , * ")
      assert bypassed?("https://h.invalid/x", "  h.invalid  ,")
      refute bypassed?("https://10.1.2.3/x", "10.0.0.0/8")
      assert bypassed?("https://10.1.2.3/x", "10.1.2.3")
    end
  end
end
