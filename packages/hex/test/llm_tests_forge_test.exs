defmodule LlmTestsForgeTest do
  use ExUnit.Case, async: true

  describe "platform_key/2" do
    test "names each platform the way the release assets do" do
      assert LlmTestsForge.platform_key({:unix, :darwin}, ~c"aarch64-apple-darwin25.0.0") ==
               "darwin-arm64"

      assert LlmTestsForge.platform_key({:unix, :darwin}, ~c"x86_64-apple-darwin23.0.0") ==
               "darwin-x64"

      assert LlmTestsForge.platform_key({:unix, :linux}, ~c"x86_64-pc-linux-gnu") == "linux-x64"

      assert LlmTestsForge.platform_key({:unix, :linux}, ~c"aarch64-unknown-linux-gnu") ==
               "linux-arm64"

      assert LlmTestsForge.platform_key({:win32, :nt}, ~c"win32") == "win32-x64"
    end

    test "keeps an unknown architecture as it is, so the message names it" do
      assert LlmTestsForge.platform_key({:unix, :linux}, ~c"i686-pc-linux-gnu") == "linux-i686"

      assert LlmTestsForge.platform_key({:unix, :freebsd}, ~c"amd64-portbld-freebsd14.0") ==
               "freebsd-x64"
    end
  end

  describe "asset_for/1" do
    test "finds the asset of a shipped platform and nothing for another" do
      assert LlmTestsForge.asset_for("darwin-arm64") == {:ok, "llm-tests-forge-darwin-arm64"}
      assert LlmTestsForge.asset_for("win32-x64") == {:ok, "llm-tests-forge-windows-x64.exe"}
      assert LlmTestsForge.asset_for("linux-i686") == :error
    end
  end

  test "the unsupported message names the platform and the install script" do
    assert LlmTestsForge.unsupported_message("linux-i686") ==
             "llm-tests-forge has no binary for linux-i686; see https://github.com/albertosca/llm-tests-forge for install.sh"
  end

  test "the base URL is this version's release unless the environment overrides it" do
    System.delete_env("LLM_TESTS_FORGE_BASE_URL")

    assert LlmTestsForge.base_url() ==
             "https://github.com/albertosca/llm-tests-forge/releases/download/v#{LlmTestsForge.version()}"

    System.put_env("LLM_TESTS_FORGE_BASE_URL", "http://127.0.0.1:1234/")
    assert LlmTestsForge.base_url() == "http://127.0.0.1:1234"
    System.delete_env("LLM_TESTS_FORGE_BASE_URL")
  end
end
