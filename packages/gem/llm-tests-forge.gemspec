# frozen_string_literal: true

require "fileutils"

# One gem per platform, built by scripts/release/gems.ts: the platform and the
# binary come from the environment, and the binary is copied to
# exe/<platform>/ inside this directory so that it ships in the gem.
%w[FORGE_GEM_PLATFORM FORGE_GEM_BINARY].each do |variable|
  raise "#{variable} is not set" if ENV.fetch(variable, "").empty?
end

platform = ENV.fetch("FORGE_GEM_PLATFORM")
binary_source = ENV.fetch("FORGE_GEM_BINARY")
raise "FORGE_GEM_BINARY does not name a file: #{binary_source}" unless File.file?(binary_source)

binary_name = platform.include?("mingw") ? "llm-tests-forge.exe" : "llm-tests-forge"
binary_relative_path = File.join("exe", platform, binary_name)
binary_destination = File.join(__dir__, binary_relative_path)
FileUtils.mkdir_p(File.dirname(binary_destination))
FileUtils.cp(binary_source, binary_destination)
File.chmod(0o755, binary_destination)

Gem::Specification.new do |specification|
  specification.name = "llm-tests-forge"
  specification.version = "0.1.0"
  specification.platform = platform
  specification.summary = "Forge reviewed regression suites for your LLM features and emit them for promptfoo"
  specification.description = "The llm-tests-forge command line tool: a prebuilt binary for #{platform}."
  specification.authors = ["Alberto de Sá Cavalcanti de Albuquerque"]
  specification.homepage = "https://github.com/albertosca/llm-tests-forge"
  specification.license = "MIT"
  specification.metadata["source_code_uri"] = "https://github.com/albertosca/llm-tests-forge"
  specification.required_ruby_version = ">= 3.0"
  specification.bindir = "exe"
  specification.executables << "llm-tests-forge"
  # LICENSE is copied in beside this file by scripts/release/gems.ts, from the repository root.
  specification.files = ["LICENSE", "exe/llm-tests-forge", "lib/llm_tests_forge.rb", binary_relative_path]
end
