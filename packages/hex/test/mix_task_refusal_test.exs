defmodule Mix.Tasks.LlmTestsForgeRefusalTest do
  # Captures stderr, which is global, so it runs alone.
  use ExUnit.Case, async: false

  import ExUnit.CaptureIO

  alias Mix.Tasks.LlmTestsForge, as: Task

  # The refusal leaves through exit({:shutdown, 2}), which mix turns into the
  # process's exit status once the VM has shut down cleanly; System.halt would
  # end this test run instead of being caught here.
  defp refusal(arguments) do
    with_io(:stderr, fn -> catch_exit(Task.run(arguments)) end)
  end

  test "review alone is refused with exit 2, naming the binary and review" do
    assert refusal(["review"]) ==
             {{:shutdown, 2},
              "review needs the terminal; run #{LlmTestsForge.binary_path()} review\n"}
  end

  test "the refusal keeps --suite <path> in the command it names, so the binary finds the suite" do
    assert refusal(["--suite", "evals/x", "review"]) ==
             {{:shutdown, 2},
              "review needs the terminal; run #{LlmTestsForge.binary_path()} --suite evals/x review\n"}
  end

  test "the refusal keeps the --suite=<path> spelling as it was given" do
    assert refusal(["--suite=evals/x", "review", "--scenario", "billing"]) ==
             {{:shutdown, 2},
              "review needs the terminal; run #{LlmTestsForge.binary_path()} --suite=evals/x review --scenario billing\n"}
  end

  test "an argument the shell would split or expand is quoted in the command it names" do
    assert refusal(["--suite", "my evals/it's", "review"]) ==
             {{:shutdown, 2},
              "review needs the terminal; run #{LlmTestsForge.binary_path()} --suite 'my evals/it'\\''s' review\n"}
  end
end
