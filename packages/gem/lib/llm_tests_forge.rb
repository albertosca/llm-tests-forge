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
  # linux-x64, win32-x64).
  ARCHITECTURE_NAMES = { "x86_64" => "x64", "x64" => "x64", "amd64" => "x64", "arm64" => "arm64",
                         "aarch64" => "arm64" }.freeze
  OPERATING_SYSTEM_NAMES = { "mingw" => "win32", "mswin" => "win32", "mswin64" => "win32" }.freeze

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

  def missing_binary_message(local_platform: Gem::Platform.local)
    "llm-tests-forge has no binary for #{platform_name(local_platform)}; see #{REPOSITORY_URL} for install.sh"
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
