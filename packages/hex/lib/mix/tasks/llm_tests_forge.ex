defmodule Mix.Tasks.LlmTestsForge do
  @shortdoc "Runs the llm-tests-forge binary, installing it first when it is missing"

  @moduledoc """
  Runs the installed `llm-tests-forge` binary with the given arguments and
  exits with its status (128 plus the signal when a signal killed it). When
  the binary is missing it is installed first, as `mix llm_tests_forge.install`
  does; that progress goes to stderr, so the binary's stdout stays its own.

      mix llm_tests_forge review
      mix llm_tests_forge --version

  **Not for interactive commands.** Mix cannot hand the terminal to the
  binary: the BEAM starts every child in a new session, so the child has no
  controlling terminal and never receives the terminal's Ctrl+C, while the VM
  answers Ctrl+C with its own break menu (which cannot be switched off from
  inside a running VM) and a second one ends it, leaving the child orphaned.
  The binary's stdin is empty and its stdout is relayed. So
  `mix llm_tests_forge review` refuses (exit 2) and names the installed binary
  to run directly, which `mix llm_tests_forge.install` also prints:

      _build/llm-tests-forge review
  """

  use Mix.Task

  @impl Mix.Task
  def run(["review" | _rest]) do
    IO.puts(
      :stderr,
      "review needs the terminal; run #{LlmTestsForge.binary_path()} review"
    )

    System.halt(2)
  end

  def run(arguments) do
    binary =LlmTestsForge.ensure_installed!(&IO.puts(:stderr, &1))

    case LlmTestsForge.run_binary(binary, arguments) do
      0 -> :ok
      status -> System.halt(status)
    end
  end
end
