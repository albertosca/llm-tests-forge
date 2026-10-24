defmodule Mix.Tasks.LlmTestsForgeTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.LlmTestsForge, as: Task

  describe "interactive_review?/1" do
    test "review alone is the interactive review" do
      assert Task.interactive_review?(["review"])
      assert Task.interactive_review?(["review", "--scenario", "billing"])
    end

    test "review after --suite <path> is the interactive review, as the binary reads it" do
      assert Task.interactive_review?(["--suite", "evals/extract", "review"])
    end

    test "review after --suite=<path> is the interactive review, as the binary reads it" do
      assert Task.interactive_review?(["--suite=evals/extract", "review"])
    end

    test "review --all asks nothing, so it is not refused, with or without --suite" do
      refute Task.interactive_review?(["review", "--scenario", "billing", "--all"])

      refute Task.interactive_review?([
               "--suite",
               "evals/extract",
               "review",
               "--all",
               "--scenario",
               "billing"
             ])
    end

    test "other verbs, and a suite path spelled review, are not the review" do
      refute Task.interactive_review?(["status"])
      refute Task.interactive_review?(["--suite", "review", "status"])
      refute Task.interactive_review?(["--suite=review", "status"])
      refute Task.interactive_review?([])
      refute Task.interactive_review?(["--", "review"])
    end

    test "review --help and review -h are not interactive: they print and exit" do
      refute Task.interactive_review?(["review", "--help"])
      refute Task.interactive_review?(["review", "-h"])
      refute Task.interactive_review?(["--suite", "evals/x", "review", "--help"])
    end
  end
end
