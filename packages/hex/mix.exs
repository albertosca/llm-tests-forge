defmodule LlmTestsForge.MixProject do
  use Mix.Project

  def project do
    [
      app: :llm_tests_forge,
      version: "0.1.0",
      elixir: "~> 1.14",
      description:
        "Mix tasks that install and run the llm-tests-forge binary from its GitHub Release, checking its SHA256",
      source_url: "https://github.com/albertosca/llm-tests-forge",
      package: [
        licenses: ["MIT"],
        links: %{"GitHub" => "https://github.com/albertosca/llm-tests-forge"},
        files: ~w(lib mix.exs checksums.exs)
      ],
      deps: []
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto, inets: :optional, ssl: :optional]]
  end
end
