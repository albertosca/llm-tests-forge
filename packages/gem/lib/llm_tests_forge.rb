# frozen_string_literal: true

require "rubygems"

# Locates and runs the llm-tests-forge binary that ships inside this gem. The
# fallback gem (platform ruby), which RubyGems installs only where no platform
# gem fits, ships none: its shim names the platform and points at install.sh.
module LlmTestsForge
  REPOSITORY_URL = "https://github.com/albertosca/llm-tests-forge"
  EXECUTABLES_DIRECTORY = File.expand_path("../exe", __dir__)
  # RubyGems' spellings of an architecture and an operating system, and the
  # names the npm package and every other package give them (darwin-arm64,
  # linux-x64, win32-x64). RubyGems spells every 32-bit x86 as x86; npm, ia32.
  ARCHITECTURE_NAMES = { "x86_64" => "x64", "x64" => "x64", "amd64" => "x64", "arm64" => "arm64",
                         "aarch64" => "arm64", "x86" => "ia32" }.freeze
  OPERATING_SYSTEM_NAMES = { "mingw" => "win32", "mingw32" => "win32", "mswin" => "win32",
                             "mswin64" => "win32" }.freeze
  # The platforms of the release's native gems, in the order of
  # scripts/release/targets.ts; the package tests check the two agree.
  RELEASE_GEM_PLATFORMS = %w[arm64-darwin x86_64-darwin x86_64-linux-gnu aarch64-linux-gnu x64-mingw-ucrt].freeze
  FALLBACK_GEM_PLATFORM = "ruby"

  module_function

  # The platform as the npm package names it: <operating system>-<architecture>.
  def platform_name(local_platform = Gem::Platform.local)
    operating_system = OPERATING_SYSTEM_NAMES.fetch(local_platform.os, local_platform.os)
    architecture = ARCHITECTURE_NAMES.fetch(local_platform.cpu, local_platform.cpu)
    "#{operating_system}-#{architecture}"
  end

  def binary_file_name(windows: Gem.win_platform?)
    windows ? "llm-tests-forge.exe" : "llm-tests-forge"
  end

  # The binary under executables_directory/<platform>/ whose platform directory
  # matches local_platform, or nil when the gem carries none for it.
  def binary_path(executables_directory: EXECUTABLES_DIRECTORY, local_platform: Gem::Platform.local,
                  windows: Gem.win_platform?)
    Dir.children(executables_directory).sort.each do |entry|
      platform_directory = File.join(executables_directory, entry)
      next unless File.directory?(platform_directory)
      next unless Gem::Platform.new(entry) === local_platform

      candidate = File.join(platform_directory, binary_file_name(windows: windows))
      return candidate if File.file?(candidate)
    end
    nil
  end

  # The platform of the llm-tests-forge gem RubyGems activated for this run
  # (ruby for the fallback), or nil when the shim runs outside RubyGems.
  def installed_gem_platform
    Gem.loaded_specs["llm-tests-forge"]&.platform&.to_s
  end

  # musl Linux (Alpine), which RubyGems reports as <cpu>-linux-musl: no
  # release binary runs there, since the Linux ones need glibc.
  def musl?(local_platform)
    local_platform.os == "linux" && local_platform.version.to_s.start_with?("musl")
  end

  # The release's native gem platform that matches local_platform, or nil.
  def native_gem_platform(local_platform)
    RELEASE_GEM_PLATFORMS.find { |platform| Gem::Platform.new(platform) === local_platform }
  end

  # What the shim says when no binary runs here: musl, which no binary
  # supports yet; the fallback gem on a platform that has a native gem, which
  # only force_ruby_platform or --platform ruby installs; or a platform
  # without a binary.
  def missing_binary_message(local_platform: Gem::Platform.local, installed_gem_platform: self.installed_gem_platform)
    name = platform_name(local_platform)
    return musl_message(name) if musl?(local_platform)

    native = native_gem_platform(local_platform)
    return fallback_chosen_message(name, native) if installed_gem_platform == FALLBACK_GEM_PLATFORM && native

    "llm-tests-forge has no binary for #{name}; see #{REPOSITORY_URL} for install.sh"
  end

  def musl_message(name)
    "llm-tests-forge has no binary for musl/Alpine yet (#{name}-musl): the #{name} binary needs glibc; " \
      "see #{REPOSITORY_URL}"
  end

  def fallback_chosen_message(name, native)
    "llm-tests-forge: this is the ruby-platform fallback gem, which has no binary, " \
      "but #{name} has a native gem (#{native}); Bundler's force_ruby_platform or " \
      "gem install --platform ruby chose the fallback. Remove force_ruby_platform for it " \
      "(bundle config unset force_ruby_platform, or force_ruby_platform: true in the Gemfile), " \
      "or run gem install llm-tests-forge without --platform ruby"
  end

  # Runs the binary as a child and returns its exit status. The shim stays
  # attached through a Ctrl+C: a terminal sends it to the whole process group,
  # and the binary decides what an interrupt means (the review saves on the
  # first and aborts with 130 on the second). A child killed by a signal is
  # reported the way a shell does, 128 plus the signal.
  def run_attached(binary, arguments)
    previous_handler = Signal.trap("INT", "IGNORE")
    begin
      Process.wait(Process.spawn(binary, *arguments))
      status = Process.last_status
    ensure
      Signal.trap("INT", previous_handler)
    end
    return 128 + status.termsig if status.signaled?

    status.exitstatus
  end

  def run(arguments, executables_directory: EXECUTABLES_DIRECTORY)
    binary = binary_path(executables_directory: executables_directory)
    if binary.nil?
      warn missing_binary_message
      exit 1
    end
    # Kernel#exec replaces the process on Unix, so signals and the exit status
    # are the binary's own. On Windows it starts the binary and exits with its
    # status, without staying attached through Ctrl+C, so run it attached.
    exit run_attached(binary, arguments) if Gem.win_platform?

    exec(binary, *arguments)
  rescue SystemCallError => error
    warn "llm-tests-forge cannot run #{binary}: #{error.message}"
    exit 1
  end
end
