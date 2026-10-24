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
  `mix llm_tests_forge review` refuses (exit 2), with or without `--suite`
  before it, and names the installed binary to run directly, with the
  arguments it was given (`--suite` included, so the binary finds the suite),
  which `mix llm_tests_forge.install` also prints:

      _build/llm-tests-forge --suite evals/x review

  `review --scenario <id> --all` asks nothing, so it runs through mix, and so
  do `review --help` and `review -h`, which only print.

  A status other than 0 leaves through `exit({:shutdown, status})`, which
  mix turns into its own exit status after the VM shuts down cleanly.
  """

  use Mix.Task

  @impl Mix.Task
  def run(arguments) do
    if interactive_review?(arguments) do
      IO.puts(
        :stderr,
        "review needs the terminal; run #{shell_command([LlmTestsForge.binary_path() | arguments])}"
      )

      exit({:shutdown, 2})
    end

    binary = LlmTestsForge.ensure_installed!(&IO.puts(:stderr, &1))

    case LlmTestsForge.run_binary(binary, arguments) do
      0 -> :ok
      status -> exit({:shutdown, status})
    end
  end

  # The words joined for a POSIX shell: a word with anything but letters,
  # digits and `@%+=:,./_-` is single-quoted, and a quote inside it closed,
  # escaped and reopened.
  defp shell_command(words) do
    Enum.map_join(words, " ", fn word ->
      if word =~ ~r{\A[A-Za-z0-9@%+=:,./_-]+\z} do
        word
      else
        "'" <> String.replace(word, "'", ~S('\'')) <> "'"
      end
    end)
  end

  @doc """
  Whether the binary would read `arguments` as the interactive review: the
  verb left once `--suite <path>` and `--suite=<path>` are taken out (as the
  binary takes them out) is `review`, without `--all`, `--help` or `-h`,
  which ask nothing.
  """
  def interactive_review?(arguments) do
    case without_suite_flag(arguments) do
      ["review" | rest] -> not Enum.any?(rest, &(&1 in ["--all", "--help", "-h"]))
      _other -> false
    end
  end

  defp without_suite_flag(["--" | _rest] = arguments), do: arguments
  defp without_suite_flag(["--suite", _path | rest]), do: without_suite_flag(rest)
  defp without_suite_flag(["--suite=" <> _path | rest]), do: without_suite_flag(rest)
  defp without_suite_flag([argument | rest]), do: [argument | without_suite_flag(rest)]
  defp without_suite_flag([]), do: []
end
