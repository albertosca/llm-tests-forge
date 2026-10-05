# frozen_string_literal: true

require "fileutils"

# One gem per platform, built by scripts/release/gems.ts: the platform and the
# binary come from the environment, and the binary is copied to
# exe/<platform>/ inside this directory so that it ships in the gem.
#
# The one exception is FORGE_GEM_PLATFORM=ruby, the fallback gem: no binary,
# so FORGE_GEM_BINARY must not be set. RubyGems prefers a gem for the local
# platform over a ruby one, so it installs the fallback only where no
# platform gem fits, and its shim names the platform and points at install.sh.
fallback_platform = "ruby"

raise "FORGE_GEM_PLATFORM is not set" if ENV.fetch("FORGE_GEM_PLATFORM", "").empty?

platform = ENV.fetch("FORGE_GEM_PLATFORM")
binary_files = []
if platform == fallback_platform
  unless ENV.fetch("FORGE_GEM_BINARY", "").empty?
    raise "FORGE_GEM_BINARY is set, but the ruby gem is the fallback and ships no binary"
  end

  description = "The llm-tests-forge command line tool, for a platform without a prebuilt binary: " \
                "it names the platform and points at install.sh."
else
  raise "FORGE_GEM_BINARY is not set" if ENV.fetch("FORGE_GEM_BINARY", "").empty?

  binary_source = ENV.fetch("FORGE_GEM_BINARY")
  raise "FORGE_GEM_BINARY does not name a file: #{binary_source}" unless File.file?(binary_source)

  binary_name = platform.include?("mingw") ? "llm-tests-forge.exe" : "llm-tests-forge"
  binary_relative_path = File.join("exe", platform, binary_name)
  binary_destination = File.join(__dir__, binary_relative_path)
  FileUtils.mkdir_p(File.dirname(binary_destination))
  FileUtils.cp(binary_source, binary_destination)
  File.chmod(0o755, binary_destination)
  binary_files << binary_relative_path
  description = "The llm-tests-forge command line tool: a prebuilt binary for #{platform}."
end

Gem::Specification.new do |specification|
  specification.name = "llm-tests-forge"
  specification.version = "0.1.0"
  specification.platform = platform
  specification.summary = "Forge reviewed regression suites for your LLM features and emit them for promptfoo"
  specification.description = description
  specification.authors = ["Alberto de Sá Cavalcanti de Albuquerque"]
  specification.homepage = "https://github.com/albertosca/llm-tests-forge"
  specification.license = "MIT"
  specification.metadata["source_code_uri"] = "https://github.com/albertosca/llm-tests-forge"
  specification.required_ruby_version = ">= 3.0"
  specification.bindir = "exe"
  specification.executables << "llm-tests-forge"
  # LICENSE is copied in beside this file by scripts/release/gems.ts, from the repository root.
  specification.files = ["LICENSE", "exe/llm-tests-forge", "lib/llm_tests_forge.rb", *binary_files]
end
